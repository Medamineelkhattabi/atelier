"""A team member that runs on an agent speaking the Agent Client Protocol (ACP, https://agentclientprotocol.com):
Gemini CLI, Codex, GitHub Copilot, Cursor, goose, OpenCode, Qwen Code, Mistral Vibe, or any other (pae.engines).

The agent runs as a child process in the project folder, on its own sign-in: the platform never gives it an API key
and removes AI vendors' keys from its environment (pae.subscription.agent_environment). The platform is the ACP
client, so the same rules as for Claude Code's tools apply to what the agent asks:
- a permission the agent asks for (an edit, a command, a web page) is decided like a Claude Code tool call: paths
  stay inside the project and out of private folders and secret files, read-only tasks change nothing, the owner's
  rules and approve modes apply, and an approval waits for the owner (without using up the task's time);
- the agent reads and writes files through the platform (fs/read_text_file, fs/write_text_file), with the same
  checks; a write the agent did not ask about first is decided like an edit;
- what the agent says, its plan, its tool calls and their results appear in the task's activity.
What an agent does without asking (its own "approve everything" setting, or work it does inside itself) is up to
that agent: the platform decides what the protocol shows it.

The task's report comes back as a JSON block at the end of the agent's last message, checked against the team
member's schema; an agent that ends without it is asked again, like a Claude Code session.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import re
import subprocess
from collections import deque
from pathlib import Path

from pae.engines import Engine
from pae.runtime import auto_approve
from pae.runtime.context import LimitExceeded, Outcome, RunContext, RunFailure
from pae.runtime.native import build_system_prompt, build_task_message, validate_output
from pae.runtime.safe_commands import is_safe_command
from pae.subscription import agent_environment
from pae.tools.base import ToolError, rel, resolve_path

log = logging.getLogger("pae.acp")

PROTOCOL_VERSION = 1
LINE_LIMIT = 64 * 1024 * 1024  # one JSON-RPC message per line; a whole file can be in one
START_TIMEOUT_S = 120.0  # starting the agent and its session: an agent waiting for a sign-in never answers
AUTH_REQUIRED = -32000
KIND_RISK = {
    "read": "read",
    "search": "read",
    "think": "read",
    "edit": "write",
    "delete": "write",
    "move": "write",
    "execute": "execute",
    "fetch": "external",
    "switch_mode": "execute",
    "other": "execute",
}
RISK_DEFAULT = {"read": "allow", "write": "ask", "execute": "ask", "external": "ask"}
WRITE_KINDS = {"edit", "move", "other"}  # an approval of these may be followed by the agent writing the file
PATH_KEYS = ("path", "file_path", "filePath", "absolute_path", "absolutePath", "dir_path", "directory", "source",
             "destination", "target", "paths", "file_paths")  # fmt: skip
COMMAND_KEYS = ("command", "cmd")
# Platform tools the agent's own tools replace: an ACP agent reads, searches, edits and runs commands itself.
OWN_TOOLS = {"fs_list", "fs_read", "fs_search", "fs_write", "shell_run"}
REPORT_REMINDERS = 2
REPORT_NOTE = (
    "## Your report\n"
    "When the task is done, end your last message with your report: one JSON object in a ```json code block, "
    "matching the JSON schema below. Write nothing after that block.\n"
    "```json\n{schema}\n```"
)
REPORT_REMINDER = (
    "Your last answer ended without a valid report ({problem}). If the task you were given is not finished, finish "
    "it now. Then end your message with the report: one JSON object in a ```json code block that matches the schema "
    "you were given."
)
FENCED_JSON = re.compile(r"```(?:json)?[ \t]*\r?\n(.*?)```", re.DOTALL)
APPROVAL_PREVIEW_CHARS = 20_000


class AcpError(Exception):
    """A JSON-RPC error, received from the agent or sent to it."""

    def __init__(self, code: int, message: str, data=None) -> None:
        super().__init__(message)
        self.code, self.message, self.data = code, message, data


class AcpClosed(Exception):
    """The agent's process ended."""


def tool_name(engine: Engine, kind: str | None) -> str:
    return f"acp.{engine.id}.{kind or 'other'}"


# ------------------------------------------------------------------ the connection


class Connection:
    """JSON-RPC 2.0 over the agent's stdin and stdout, one message per line (ACP's stdio transport)."""

    def __init__(self, process, on_request, on_notification) -> None:
        self.process = process
        self.on_request = on_request
        self.on_notification = on_notification
        self._next_id = 0
        self._pending: dict[int, asyncio.Future] = {}
        self._answering: set[asyncio.Task] = set()
        self._write_lock = asyncio.Lock()
        self._reader = asyncio.create_task(self._read(), name="acp-reader")

    async def request(self, method: str, params: dict):
        self._next_id += 1
        request_id = self._next_id
        future = asyncio.get_running_loop().create_future()
        self._pending[request_id] = future
        try:
            await self._send({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params})
            return await future
        finally:
            self._pending.pop(request_id, None)

    async def notify(self, method: str, params: dict) -> None:
        await self._send({"jsonrpc": "2.0", "method": method, "params": params})

    async def _send(self, message: dict) -> None:
        if self.process.stdin is None or self.process.stdin.is_closing():
            raise AcpClosed("the agent's input is closed")
        line = json.dumps(message, ensure_ascii=False, separators=(",", ":"), default=str) + "\n"
        async with self._write_lock:
            try:
                self.process.stdin.write(line.encode("utf-8"))
                await self.process.stdin.drain()
            except (BrokenPipeError, ConnectionResetError, RuntimeError) as exc:
                raise AcpClosed("the agent stopped reading") from exc

    async def _read(self) -> None:
        try:
            while True:
                try:
                    line = await self.process.stdout.readline()
                except ValueError:  # a line over LINE_LIMIT: the stream cannot be read on
                    log.warning("ACP agent sent a message over %s bytes", LINE_LIMIT)
                    break
                if not line:
                    break
                line = line.strip()
                if not line:
                    continue
                try:
                    message = json.loads(line)
                except ValueError:
                    log.debug("ACP agent wrote a line that is not JSON-RPC: %r", line[:200])
                    continue
                if isinstance(message, dict):
                    await self._dispatch(message)
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 - a broken stream ends the connection, it must not crash the run silently
            log.exception("ACP reader stopped")
        finally:
            for future in self._pending.values():
                if not future.done():
                    future.set_exception(AcpClosed("the agent stopped"))

    async def _dispatch(self, message: dict) -> None:
        method = message.get("method")
        if isinstance(method, str):
            params = message.get("params") if isinstance(message.get("params"), dict) else {}
            if "id" in message:  # a request: answered in its own task, so an approval does not stop the reading
                task = asyncio.create_task(self._answer(message["id"], method, params))
                self._answering.add(task)
                task.add_done_callback(self._answering.discard)
            else:  # a notification: handled in order (updates arrive in the order they happened)
                try:
                    await self.on_notification(method, params)
                except Exception:  # noqa: BLE001
                    log.exception("ACP notification %s failed", method)
            return
        future = self._pending.get(message.get("id"))
        if future is None or future.done():
            return
        error = message.get("error")
        if isinstance(error, dict):
            future.set_exception(
                AcpError(int(error.get("code", -32603)), str(error.get("message", "")), error.get("data"))
            )
        else:
            future.set_result(message.get("result"))

    async def _answer(self, request_id, method: str, params: dict) -> None:
        try:
            result = await self.on_request(method, params)
            reply = {"jsonrpc": "2.0", "id": request_id, "result": result}
        except asyncio.CancelledError:
            if method == "session/request_permission":
                with contextlib.suppress(AcpClosed):
                    await self._send(
                        {"jsonrpc": "2.0", "id": request_id, "result": {"outcome": {"outcome": "cancelled"}}}
                    )
            raise
        except AcpError as exc:
            reply = {"jsonrpc": "2.0", "id": request_id, "error": {"code": exc.code, "message": exc.message}}
        except Exception as exc:  # noqa: BLE001
            log.exception("ACP request %s failed", method)
            reply = {"jsonrpc": "2.0", "id": request_id, "error": {"code": -32603, "message": f"{type(exc).__name__}"}}
        with contextlib.suppress(AcpClosed):
            await self._send(reply)

    async def close(self) -> None:
        for task in list(self._answering):
            task.cancel()
        if self._answering:
            await asyncio.gather(*self._answering, return_exceptions=True)
        self._reader.cancel()
        await asyncio.gather(self._reader, return_exceptions=True)


async def start_process(executable: str, args: tuple[str, ...], workspace: Path, env: dict):
    extra = {"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {"start_new_session": True}
    return await asyncio.create_subprocess_exec(
        executable,
        *args,
        cwd=str(workspace),
        env=env,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        limit=LINE_LIMIT,
        **extra,
    )


async def stop_process(process) -> None:
    """Close the agent's input (agents end on it), then stop it and what it started."""
    if process.returncode is not None:
        return
    with contextlib.suppress(Exception):
        process.stdin.close()
    try:
        await asyncio.wait_for(process.wait(), 3)
        return
    except TimeoutError:
        pass
    if os.name == "nt":
        await asyncio.to_thread(
            subprocess.run, ["taskkill", "/PID", str(process.pid), "/T", "/F"], capture_output=True, check=False
        )
    else:
        import signal

        with contextlib.suppress(ProcessLookupError, PermissionError):
            os.killpg(process.pid, signal.SIGKILL)
    with contextlib.suppress(TimeoutError):
        await asyncio.wait_for(process.wait(), 5)


# ------------------------------------------------------------------ what a tool call names


def call_paths(call: dict) -> list[str]:
    found: list[str] = []
    for location in call.get("locations") or []:
        if isinstance(location, dict) and isinstance(location.get("path"), str):
            found.append(location["path"])
    for item in call.get("content") or []:
        if isinstance(item, dict) and item.get("type") == "diff" and isinstance(item.get("path"), str):
            found.append(item["path"])
    raw = call.get("rawInput")
    if isinstance(raw, dict):
        for key in PATH_KEYS:
            value = raw.get(key)
            if isinstance(value, str) and value.strip():
                found.append(value)
            elif isinstance(value, list):
                found.extend(v for v in value if isinstance(v, str) and v.strip())
    return list(dict.fromkeys(found))


def call_command(call: dict) -> str | None:
    raw = call.get("rawInput")
    if not isinstance(raw, dict):
        return None
    for key in COMMAND_KEYS:
        value = raw.get(key)
        if isinstance(value, str) and value.strip():
            return value
        if isinstance(value, list) and value and all(isinstance(v, str) for v in value):
            return " ".join(value)
    return None


def call_diff(call: dict) -> dict | None:
    for item in call.get("content") or []:
        if isinstance(item, dict) and item.get("type") == "diff":
            return {"path": item.get("path"), "oldText": item.get("oldText"), "newText": item.get("newText")}
    return None


def content_text(block) -> str:
    if not isinstance(block, dict):
        return ""
    kind = block.get("type")
    if kind == "text":
        return str(block.get("text") or "")
    if kind == "resource_link":
        return str(block.get("name") or block.get("uri") or "")
    if kind == "resource" and isinstance(block.get("resource"), dict):
        return str(block["resource"].get("text") or block["resource"].get("uri") or "")
    if kind in ("image", "audio"):
        return f"[{kind}]"
    return ""


def call_output(call: dict) -> str:
    parts: list[str] = []
    for item in call.get("content") or []:
        if not isinstance(item, dict):
            continue
        if item.get("type") == "content":
            parts.append(content_text(item.get("content")))
        elif item.get("type") == "diff":
            parts.append(f"Changed {item.get('path')}")
        elif item.get("type") == "terminal":
            parts.append(f"[terminal {item.get('terminalId')}]")
    raw = call.get("rawOutput")
    if isinstance(raw, str):
        parts.append(raw)
    elif raw is not None and not parts:
        parts.append(json.dumps(raw, ensure_ascii=False, default=str))
    return "\n".join(p for p in parts if p).strip()


def call_input(call: dict) -> dict:
    raw = call.get("rawInput")
    data = dict(raw) if isinstance(raw, dict) else {}
    if call.get("title"):
        data.setdefault("title", call["title"])
    return data


def approval_args(call: dict) -> dict:
    diff = call_diff(call)
    raw = call.get("rawInput") if isinstance(call.get("rawInput"), dict) else {}
    paths = call_paths(call)
    content = (diff or {}).get("newText") or raw.get("content")
    args = {
        "title": call.get("title"),
        "command": call_command(call),
        "path": paths[0] if paths else None,
        "content": content[:APPROVAL_PREVIEW_CHARS] if isinstance(content, str) else None,
        "url": raw.get("url") if isinstance(raw.get("url"), str) else None,
        "diff": diff,
    }
    return {key: value for key, value in args.items() if value is not None}


# ------------------------------------------------------------------ the platform's rules


def permission(ctx: RunContext, engine: Engine, kind: str, call: dict) -> tuple[str, str]:
    """allow / ask / deny for what the agent asks to do, with the rule that decided it."""
    risk = KIND_RISK.get(kind, "execute")
    tool = tool_name(engine, kind)
    for path in call_paths(call):
        try:
            resolve_path(ctx.workspace, path)
        except ToolError as exc:
            return "deny", str(exc)
    command = call_command(call)
    owner = ctx.manager.settings.get("permissions.tools", {}).get(tool)
    agent = ctx.agent.permissions.get(tool)
    for value, rule in ((owner, "global"), (agent, "agent")):
        if value == "deny":
            return "deny", rule
    if ctx.options.get("read_only"):
        if risk == "read":
            return "allow", "read-only task"
        if risk == "execute" and command and is_safe_command(command, ctx.workspace, checks=False):
            return "allow", "read-only task"
        return "deny", "read-only task: it changes nothing"
    for value, rule in ((owner, "global"), (agent, "agent")):
        if value:
            return value, rule
    if ctx.project_trust_edits and kind == "edit":
        decision, rule = "allow", "project"
    elif ctx.project_trust_edits and risk == "execute" and command and is_safe_command(command, ctx.workspace):
        decision, rule = "allow", "project"  # only reads the project or runs its checks
    else:
        decision, rule = RISK_DEFAULT[risk], "default"
    if (
        decision == "ask"
        and risk == "execute"
        and command is None
        and auto_approve.is_on(ctx)
        and ctx.manager.settings.get("permissions.mode") == "auto"
    ):
        return "ask", "still asks in auto mode: the agent did not say which command it runs"
    return auto_approve.decide(ctx, decision, rule, tool, command if risk == "execute" else None)


def pick_option(options, kinds: tuple[str, ...]) -> dict | None:
    for kind in kinds:
        for option in options or []:
            if isinstance(option, dict) and option.get("kind") == kind and option.get("optionId") is not None:
                return option
    return None


def read_report(text: str, schema: dict) -> tuple[dict | None, str]:
    """The report at the end of the agent's message, or why there is none."""
    candidates = [m.group(1) for m in FENCED_JSON.finditer(text)]
    stripped = text.strip()
    if stripped.startswith("{") and stripped.endswith("}"):
        candidates.append(stripped)
    if not candidates:
        return None, "no JSON report was found"
    problem = "the JSON report could not be read"
    for candidate in reversed(candidates):
        try:
            value = json.loads(candidate)
        except ValueError:
            continue
        if not isinstance(value, dict):
            problem = "the report is not a JSON object"
            continue
        errors = validate_output(schema, value)
        if not errors:
            return value, ""
        return None, "the report does not match the schema: " + "; ".join(errors[:5])
    return None, problem


# ------------------------------------------------------------------ the agent's session


class AcpSession:
    def __init__(self, ctx: RunContext, engine: Engine) -> None:
        self.ctx, self.engine = ctx, engine
        self.conn: Connection | None = None
        self.session_id: str | None = None
        self.calls: dict[str, dict] = {}
        self.message: list[str] = []  # what the agent said, not shown yet
        self.thought: list[str] = []
        self.turn_text: list[str] = []  # what the agent said in the current turn
        self.approved_writes: dict[Path, int] = {}
        self.unlocated_approvals = 0
        self.usage: dict = {}
        self.limit_hit: LimitExceeded | None = None
        self.writes = 0

    # ---- agent -> platform

    async def on_notification(self, method: str, params: dict) -> None:
        if method != "session/update" or not isinstance(params.get("update"), dict):
            return
        update = params["update"]
        kind = update.get("sessionUpdate")
        ctx = self.ctx
        if kind == "agent_message_chunk":
            text = content_text(update.get("content"))
            if text:
                self.message.append(text)
        elif kind == "agent_thought_chunk":
            text = content_text(update.get("content"))
            if text:
                self.thought.append(text)
        elif kind == "tool_call":
            await self.flush()
            call = self._call(update)
            ctx.tool_calls += 1
            ctx.steps += 1
            ctx.save_counters()
            await ctx.emit(
                "agent.tool_call",
                "agent",
                {
                    "tool_call_id": call["id"],
                    "tool": tool_name(self.engine, call.get("kind")),
                    "input": call_input(call),
                },
            )
            maximum = int(ctx.limits["max_steps"])
            if ctx.steps > maximum and self.limit_hit is None:
                self.limit_hit = LimitExceeded("max_steps", ctx.steps, maximum)
                await ctx.emit("limit.exceeded", "runtime", {"limit": "max_steps", "value": ctx.steps, "max": maximum})
                await self.cancel()
        elif kind == "tool_call_update":
            call = self.calls.get(str(update.get("toolCallId")))
            before = call.get("status") if call else None
            call = self._call(update)
            status = call.get("status")
            if status == "in_progress" and not call.get("_started"):
                call["_started"] = True
                await ctx.emit("tool.started", "tool", {"tool_call_id": call["id"], "tool": self._tool(call)})
            if status in ("completed", "failed") and before not in ("completed", "failed"):
                output = call_output(call)
                failed = status == "failed"
                await ctx.emit(
                    "tool.failed" if failed else "tool.completed",
                    "tool",
                    {
                        "tool_call_id": call["id"],
                        "tool": self._tool(call),
                        "output": ctx.manager.redactor.text(output[:8000]),
                        **({"error": ctx.manager.redactor.text(output[:2000]) or "failed"} if failed else {}),
                    },
                )
        elif kind == "plan":
            lines = [
                f"- [{entry.get('status', 'pending')}] {entry.get('content', '')}"
                for entry in update.get("entries") or []
                if isinstance(entry, dict)
            ]
            if lines:
                await ctx.emit("agent.reasoning", "agent", {"text": "Plan:\n" + "\n".join(lines), "kind": "plan"})
        elif kind == "usage_update":
            self.usage = {"context_used": update.get("used"), "context_size": update.get("size")}

    async def on_request(self, method: str, params: dict):
        if method == "session/request_permission":
            return await self.request_permission(params)
        if method == "fs/read_text_file":
            return await self.read_file(params)
        if method == "fs/write_text_file":
            return await self.write_file(params)
        raise AcpError(-32601, f"the platform does not offer {method}")

    def _call(self, update: dict) -> dict:
        call_id = str(update.get("toolCallId") or f"acp_{len(self.calls) + 1}")
        call = self.calls.setdefault(call_id, {"id": call_id})
        call.update({k: v for k, v in update.items() if v is not None and k not in ("sessionUpdate", "toolCallId")})
        return call

    def _tool(self, call: dict) -> str:
        return tool_name(self.engine, call.get("kind"))

    async def request_permission(self, params: dict) -> dict:
        ctx = self.ctx
        call = self._call(params.get("toolCall") if isinstance(params.get("toolCall"), dict) else {})
        kind = str(call.get("kind") or "other")
        tool = tool_name(self.engine, kind)
        decision, rule = permission(ctx, self.engine, kind, call)
        await ctx.emit(
            "tool.permission",
            "runtime",
            {"tool_call_id": call["id"], "tool": tool, "decision": decision, "rule": rule},
        )
        if decision == "ask":
            approved, rule = await self._ask_owner(
                tool, call["id"], approval_args(call), KIND_RISK.get(kind, "execute")
            )
            decision = "allow" if approved else "deny"
        options = params.get("options") or []
        if decision != "allow":
            option = pick_option(options, ("reject_once", "reject_always"))
            return {"outcome": {"outcome": "selected", "optionId": option["optionId"]}} if option else _cancelled()
        if kind in WRITE_KINDS:
            self._remember_write(call)
        if not call.get("_started"):
            call["_started"] = True
            await ctx.emit("tool.started", "tool", {"tool_call_id": call["id"], "tool": tool})
        # "Allow once" keeps every later call in front of the platform; "always" would let the agent stop asking.
        option = pick_option(options, ("allow_once",))
        if option is None:
            option = pick_option(options, ("allow_always",))
            if option is not None:
                note = f"{self.engine.name} offered no one-time approval: it was allowed with its 'always' choice"
                await ctx.emit("runtime.note", "runtime", {"message": note})
        return {"outcome": {"outcome": "selected", "optionId": option["optionId"]}} if option else _cancelled()

    async def _ask_owner(self, tool: str, call_id: str, args: dict, risk: str) -> tuple[bool, str]:
        ctx = self.ctx
        with ctx.manager.owner_awaited(ctx):  # waiting for the owner does not use up the task's time
            status, note = await ctx.manager.approvals.request(
                run_id=ctx.run_id,
                root_run_id=ctx.root_run_id,
                agent_id=ctx.agent.id,
                tool=tool,
                tool_call_id=call_id,
                args=args,
                risk=risk,
                reason=None,
                timeout_s=float(ctx.limits["approval_timeout_s"]),
                on_wait=lambda: ctx.manager.approval_waiting(ctx),
                on_resume=lambda: ctx.manager.set_status(ctx, "running"),
            )
        if status == "approved":
            return True, "approved by the owner"
        return False, f"the owner did not approve this action ({status}). {note or ''}".strip()

    def _remember_write(self, call: dict) -> None:
        paths = []
        for path in call_paths(call):
            with contextlib.suppress(ToolError):
                paths.append(resolve_path(self.ctx.workspace, path))
        if not paths:
            self.unlocated_approvals += 1
        for path in paths:
            self.approved_writes[path] = self.approved_writes.get(path, 0) + 1

    def _use_write_approval(self, target: Path) -> bool:
        if self.approved_writes.get(target):
            self.approved_writes[target] -= 1
            return True
        if self.unlocated_approvals:
            self.unlocated_approvals -= 1
            return True
        return False

    async def read_file(self, params: dict) -> dict:
        try:
            target = resolve_path(self.ctx.workspace, str(params.get("path") or ""), must_exist=True)
        except ToolError as exc:
            raise AcpError(-32602, str(exc)) from exc
        if not target.is_file():
            raise AcpError(-32602, f"'{params.get('path')}' is not a file")
        text = await asyncio.to_thread(target.read_text, encoding="utf-8", errors="replace")
        line, limit = params.get("line"), params.get("limit")
        if line is not None or limit is not None:
            lines = text.splitlines(keepends=True)
            start = max(int(line or 1), 1) - 1
            text = "".join(lines[start : start + int(limit)] if limit is not None else lines[start:])
        return {"content": text}

    async def write_file(self, params: dict) -> dict:
        ctx = self.ctx
        raw = str(params.get("path") or "")
        content = params.get("content")
        if not isinstance(content, str):
            raise AcpError(-32602, "content must be text")
        tool = tool_name(self.engine, "write_file")
        self.writes += 1
        call_id = f"write_{self.writes}"
        try:
            target = resolve_path(ctx.workspace, raw)
        except ToolError as exc:
            await ctx.emit(
                "tool.permission",
                "runtime",
                {"tool_call_id": call_id, "tool": tool, "decision": "deny", "rule": str(exc)},
            )
            raise AcpError(-32602, str(exc)) from exc
        shown = rel(ctx.workspace, target)
        if not self._use_write_approval(target):
            # The agent writes without having asked first: decided like an edit it asked for.
            call = {"kind": "edit", "locations": [{"path": raw}], "rawInput": {"path": shown, "content": content}}
            decision, rule = permission(ctx, self.engine, "edit", call)
            await ctx.emit(
                "tool.permission",
                "runtime",
                {"tool_call_id": call_id, "tool": tool, "decision": decision, "rule": rule},
            )
            if decision == "ask":
                args = {"path": shown, "content": content[:APPROVAL_PREVIEW_CHARS]}
                approved, rule = await self._ask_owner(tool, call_id, args, "write")
                decision = "allow" if approved else "deny"
            if decision != "allow":
                raise AcpError(-32001, f"not written: {rule}")
        await asyncio.to_thread(_write_text, target, content)
        await ctx.emit("tool.completed", "tool", {"tool_call_id": call_id, "tool": tool, "output": f"Wrote {shown}"})
        return {}

    # ---- platform -> agent

    async def prompt(self, text: str) -> str | None:
        self.turn_text = []
        result = await self.conn.request(
            "session/prompt", {"sessionId": self.session_id, "prompt": [{"type": "text", "text": text}]}
        )
        await self.flush()
        if self.limit_hit is not None:
            raise self.limit_hit
        return (result or {}).get("stopReason") if isinstance(result, dict) else None

    async def cancel(self) -> None:
        if self.conn is not None and self.session_id:
            with contextlib.suppress(AcpClosed):
                await self.conn.notify("session/cancel", {"sessionId": self.session_id})

    async def flush(self) -> None:
        """Show what the agent said and thought since the last tool call, as whole messages."""
        if self.thought:
            text, self.thought = "".join(self.thought), []
            if text.strip():
                await self.ctx.emit("agent.reasoning", "agent", {"text": text, "kind": "provider_summary"})
        if self.message:
            text, self.message = "".join(self.message), []
            if text.strip():
                self.turn_text.append(text)
                await self.ctx.emit("agent.message", "agent", {"text": text})


def _cancelled() -> dict:
    return {"outcome": {"outcome": "cancelled"}}


def _write_text(target: Path, content: str) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8", newline="")


def first_prompt(ctx: RunContext) -> str:
    note = REPORT_NOTE.format(schema=json.dumps(ctx.agent.output_schema, indent=2)) if ctx.agent.output_schema else None
    system = build_system_prompt(ctx, report_note=note)
    task = build_task_message(ctx)["content"][0]["text"]
    return f"{system}\n\n## Your task\n{task}"


def _signed_out(exc: AcpError) -> bool:
    text = f"{exc.message} {exc.data or ''}".lower()
    return exc.code == AUTH_REQUIRED or "auth" in text or "login" in text or "sign in" in text


async def run_acp(ctx: RunContext) -> Outcome:
    engine = ctx.manager.providers.engines.for_provider(ctx.provider_name)
    if engine is None:
        raise RunFailure(f"'{ctx.provider_name}' is not an agent this platform knows", code="provider_error")
    executable = engine.executable()
    if not executable:
        raise RunFailure(
            f"{engine.name} is not installed on this PC ({engine.command} not found). Install it: {engine.install}. "
            f"Then sign in once: {engine.sign_in}",
            code="provider_error",
        )
    team_tools = [name for name in ctx.tool_names() if name.startswith("agent_")]
    if team_tools:
        raise RunFailure(
            f"{ctx.agent.name} works with the platform's team tools ({', '.join(team_tools)}), which only Claude Code "
            "can use today: let it run on Claude Code.",
            code="invalid",
        )
    env, removed = agent_environment()
    tools_bin = ctx.manager.tools_bin()
    if tools_bin:  # last on the PATH, as for Claude Code
        env["PATH"] = env.get("PATH", "") + os.pathsep + str(tools_bin)
    try:
        process = await start_process(executable, engine.args, ctx.workspace, env)
    except OSError as exc:
        raise RunFailure(f"{engine.name} could not start: {exc}", code="provider_error") from exc

    stderr_lines: deque[str] = deque(maxlen=50)

    async def drain_stderr() -> None:
        while process.stderr is not None:
            line = await process.stderr.readline()
            if not line:
                return
            stderr_lines.append(line.decode("utf-8", errors="replace").rstrip())

    stderr_task = asyncio.create_task(drain_stderr())
    session = AcpSession(ctx, engine)
    conn = Connection(process, session.on_request, session.on_notification)
    session.conn = conn

    def failure(message: str, code: str = "provider_error") -> RunFailure:
        detail = " | ".join(list(stderr_lines)[-5:])
        return RunFailure(ctx.manager.redactor.text(f"{message} {detail}".strip()), code=code)

    try:
        try:
            init = await asyncio.wait_for(
                conn.request(
                    "initialize",
                    {
                        "protocolVersion": PROTOCOL_VERSION,
                        "clientCapabilities": {"fs": {"readTextFile": True, "writeTextFile": True}, "terminal": False},
                        "clientInfo": {"name": "atelier", "title": "Atelier", "version": "1.0.0"},
                    },
                ),
                START_TIMEOUT_S,
            )
            init = init if isinstance(init, dict) else {}
            if init.get("protocolVersion") != PROTOCOL_VERSION:
                raise failure(
                    f"{engine.name} speaks ACP version {init.get('protocolVersion')}; the platform speaks version "
                    f"{PROTOCOL_VERSION}. Update {engine.name}."
                )
            try:
                created = await asyncio.wait_for(
                    conn.request("session/new", {"cwd": str(ctx.workspace), "mcpServers": []}), START_TIMEOUT_S
                )
            except AcpError as exc:
                if _signed_out(exc):
                    raise failure(f"{engine.name} is not signed in. {engine.sign_in}", "not_signed_in") from exc
                raise
            session.session_id = str((created or {}).get("sessionId") or "")
            if not session.session_id:
                raise failure(f"{engine.name} started no session")
        except TimeoutError as exc:
            raise failure(
                f"{engine.name} did not answer within {int(START_TIMEOUT_S)} s. It may be waiting for a sign-in: "
                f"{engine.sign_in}"
            ) from exc
        info = init.get("agentInfo") if isinstance(init.get("agentInfo"), dict) else {}
        version = " ".join(
            str(v) for v in (info.get("title") or info.get("name") or engine.name, info.get("version")) if v
        )
        ctx.manager.update_run(ctx.run_id, model=version[:120])
        await ctx.emit(
            "runtime.note",
            "runtime",
            {
                "message": f"{engine.name} session started",
                "agent": version,
                "protocol_version": PROTOCOL_VERSION,
                "auth_method": f"{engine.name}'s own sign-in ({engine.plan})",
                "api_keys_removed": removed,  # names only
            },
        )
        unused = [n for n in ctx.tool_names() if n not in OWN_TOOLS]
        if unused:
            note = f"Not available on {engine.name}: {', '.join(unused)}. It works with its own tools instead"
            await ctx.emit("runtime.note", "runtime", {"message": note})

        stop = await session.prompt(first_prompt(ctx))
        _check_stop(engine, stop)
        report = None
        if ctx.agent.output_schema:
            for attempt in range(REPORT_REMINDERS + 1):
                report, problem = read_report("\n".join(session.turn_text), ctx.agent.output_schema)
                if report is not None:
                    break
                if attempt == REPORT_REMINDERS:
                    raise failure(
                        f"{engine.name} ended without the report the task asks for ({problem})", "no_final_answer"
                    )
                await ctx.emit(
                    "runtime.note",
                    "runtime",
                    {"message": f"The session ended without its report ({problem}): the platform asked for it again"},
                )
                stop = await session.prompt(REPORT_REMINDER.format(problem=problem))
                _check_stop(engine, stop)
    except asyncio.CancelledError:
        await session.cancel()
        raise
    except AcpClosed as exc:
        raise failure(f"{engine.name} stopped unexpectedly ({exc}).") from exc
    except AcpError as exc:
        if _signed_out(exc):
            raise failure(f"{engine.name} is not signed in. {engine.sign_in}", "not_signed_in") from exc
        raise failure(f"{engine.name} reported an error: {exc.message}") from exc
    finally:
        await conn.close()
        await stop_process(process)
        stderr_task.cancel()
        await asyncio.gather(stderr_task, return_exceptions=True)

    text = "\n".join(session.turn_text).strip()
    await ctx.emit(
        "model.response",
        "runtime",
        {
            "provider": ctx.provider_name,
            "model": version,
            "stop_reason": stop,
            "usage": session.usage,
            "cost_usd": 0.0,
            "cost_estimated": False,
            "cost_note": f"Runs on {engine.plan.lower()}; the agent reports no token counts to the platform",
        },
    )
    if report is not None:
        await ctx.emit("agent.final", "agent", {"output": report})
        return Outcome(output=report, output_text=text)
    await ctx.emit("agent.final", "agent", {"output_text": text})
    return Outcome(output=None, output_text=text)


def _check_stop(engine: Engine, stop: str | None) -> None:
    if stop == "refusal":
        raise RunFailure(f"{engine.name} refused to do this task", code="provider_error")
    if stop == "cancelled":
        raise RunFailure(f"{engine.name} stopped the task before its end", code="provider_error")
