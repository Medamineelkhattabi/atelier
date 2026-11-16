"""The single gate every tool call passes through: allow-list, argument
validation, permission policy, human approval, timeout, redaction, events.
"""

from __future__ import annotations

import json
import logging
import time

from pydantic import ValidationError

from pae.providers.base import tool_result_block
from pae.runtime import auto_approve
from pae.runtime.context import RunContext
from pae.tools.base import PERMISSION_ORDER, Tool, ToolContext, ToolError, truncate

log = logging.getLogger("pae.gate")

# File edits a project can allow without asking; commands, deletions and outside contacts still ask.
TRUSTED_EDIT_TOOLS = {"fs_write"}


def resolve_permission(tool: Tool, args, ctx: RunContext, tool_ctx: ToolContext) -> tuple[str, str]:
    """Owner layers win in order global > agent > project > argument-based > tool default.
    A 'deny' at any layer wins over everything. The project layer only ever allows file edits."""
    if ctx.options.get("read_only") and tool.risk != "read":
        return "deny", "read-only task"  # a diagnosis the app watcher started: it changes nothing
    decision, rule = _layers(tool, args, ctx, tool_ctx)
    command = args.get("command") if isinstance(args, dict) else getattr(args, "command", None)
    external = tool.risk == "external" and tool.name != "web_fetch"  # web_fetch only reads (GET)
    return auto_approve.decide(ctx, decision, rule, tool.name, command if isinstance(command, str) else None, external)


def _layers(tool: Tool, args, ctx: RunContext, tool_ctx: ToolContext) -> tuple[str, str]:
    settings = ctx.manager.settings
    layers: list[tuple[str, str | None]] = [
        ("global", settings.get("permissions.tools", {}).get(tool.name)),
        ("agent", ctx.agent.permissions.get(tool.name)),
        ("project", "allow" if ctx.project_trust_edits and tool.name in TRUSTED_EDIT_TOOLS else None),
        ("arguments", tool.dynamic_permission(args, tool_ctx) if tool.dynamic_permission else None),
        ("default", tool.default_permission),
    ]
    if any(value == "deny" for _, value in layers):
        rule = next(name for name, value in layers if value == "deny")
        return "deny", rule
    for name, value in layers:
        if value in PERMISSION_ORDER:
            return value, name
    return "ask", "fallback"


def wrap_untrusted(tool_name: str, content: str) -> str:
    safe = content.replace("</untrusted_data>", "</untrusted_data_>")
    return f'<untrusted_data source="{tool_name}">\n{safe}\n</untrusted_data>'


class ToolGate:
    def __init__(self, ctx: RunContext) -> None:
        self.ctx = ctx
        self.manager = ctx.manager

    def tool_context(self) -> ToolContext:
        return ToolContext(
            run_id=self.ctx.run_id,
            root_run_id=self.ctx.root_run_id,
            agent_id=self.ctx.agent.id,
            workspace=self.ctx.workspace,
            settings=self.manager.settings,
            secrets=lambda name: self.manager.get_secret(name, project_id=self.ctx.project_id),
            redactor=self.manager.redactor,
            emit=self.ctx.emit,
            manager=self.manager,
            agent=self.ctx.agent,
            depth=self.ctx.depth,
            project_id=self.ctx.project_id,
        )

    def allowed(self, name: str) -> bool:
        return name in self.ctx.tool_names()

    async def execute(self, call: dict, reason: str | None = None) -> dict:
        """Run one tool call and return the tool_result block for the model."""
        ctx, name, call_id = self.ctx, call["name"], call["id"]
        tool = self.manager.tools.get(name)
        if tool is None or not self.allowed(name):
            message = f"tool '{name}' is not available to this agent"
            await ctx.emit("tool.failed", "tool", {"tool_call_id": call_id, "tool": name, "error": message})
            return tool_result_block(call_id, message, is_error=True)
        try:
            args = tool.args_model.model_validate(call.get("input") or {})
        except ValidationError as exc:
            errors = "; ".join(f"{'.'.join(map(str, e['loc'])) or 'input'}: {e['msg']}" for e in exc.errors())
            message = f"invalid arguments for {name}: {errors}"
            await ctx.emit("tool.failed", "tool", {"tool_call_id": call_id, "tool": name, "error": message})
            return tool_result_block(call_id, message, is_error=True)

        tool_ctx = self.tool_context()
        permission, rule = resolve_permission(tool, args, ctx, tool_ctx)
        await ctx.emit(
            "tool.permission", "runtime", {"tool_call_id": call_id, "tool": name, "decision": permission, "rule": rule}
        )
        if permission == "deny":
            return tool_result_block(call_id, f"permission denied by policy ({rule} rule) for {name}", True)
        if permission == "ask":
            with self.manager.owner_awaited(ctx):  # waiting for the owner does not use up the task's time
                status, note = await self.manager.approvals.request(
                    run_id=ctx.run_id,
                    root_run_id=ctx.root_run_id,
                    agent_id=ctx.agent.id,
                    tool=name,
                    tool_call_id=call_id,
                    args=args.model_dump(mode="json", by_alias=True),
                    risk=tool.risk,
                    reason=reason,
                    timeout_s=float(ctx.limits["approval_timeout_s"]),
                    on_wait=lambda: self.manager.approval_waiting(ctx),
                    on_resume=lambda: self.manager.set_status(ctx, "running"),
                )
            if status != "approved":
                detail = f" Owner note: {note}" if note else ""
                return tool_result_block(
                    call_id,
                    f"The owner did not approve this {name} call (status: {status}).{detail} "
                    "Do not retry the same action; adapt your approach or explain what is needed.",
                    True,
                )

        ctx.tool_calls += 1
        ctx.save_counters()
        await ctx.emit("tool.started", "tool", {"tool_call_id": call_id, "tool": name})
        started = time.monotonic()
        timeout = max(1.0, min(tool.timeout_s, ctx.remaining_s()))
        try:
            # A tool that waits for other runs (a plan, a delegation) also stops its clock while they wait for the
            # owner (RunContext.deadline).
            async with ctx.deadline(timeout):
                result = await tool.handler(args, tool_ctx)
        except ToolError as exc:
            return await self._failed(call_id, name, str(exc), started)
        except TimeoutError:
            return await self._failed(call_id, name, f"timed out after {timeout:.0f}s", started)
        except Exception as exc:  # a tool bug must not crash the run
            log.exception("tool %s crashed", name)
            return await self._failed(call_id, name, f"internal error in {name}: {type(exc).__name__}: {exc}", started)

        limit = int(ctx.limits["tool_output_chars"])
        content = truncate(self.manager.redactor.text(result.content), limit)
        duration_ms = int((time.monotonic() - started) * 1000)
        store_output = self.manager.settings.get("logging.store_tool_outputs", True)
        await ctx.emit(
            "tool.completed" if not result.is_error else "tool.failed",
            "tool",
            {
                "tool_call_id": call_id,
                "tool": name,
                "duration_ms": duration_ms,
                "output": truncate(content, 8000) if store_output else f"[{len(content)} characters, not stored]",
                "data": _small(result.data) if store_output else None,
                **({"error": truncate(content, 2000)} if result.is_error else {}),
            },
        )
        if tool.untrusted_output:
            content = wrap_untrusted(name, content)
        return tool_result_block(call_id, content, is_error=result.is_error)

    async def _failed(self, call_id: str, name: str, message: str, started: float) -> dict:
        message = self.manager.redactor.text(message)
        await self.ctx.emit(
            "tool.failed",
            "tool",
            {
                "tool_call_id": call_id,
                "tool": name,
                "error": message,
                "duration_ms": int((time.monotonic() - started) * 1000),
            },
        )
        return tool_result_block(call_id, f"Error: {message}", is_error=True)


def _small(data, limit: int = 20_000):
    if data is None:
        return None
    text = json.dumps(data, default=str)
    return data if len(text) <= limit else {"truncated": True, "preview": text[:limit]}
