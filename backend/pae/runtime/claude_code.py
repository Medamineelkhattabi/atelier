"""Agent loop driven by Claude Code (Claude Agent SDK), for the `claude-code` provider.

Runs on the owner's existing Claude Code login (subscription) with no API key.
Isolation: no user/project settings, no plugins, only our MCP server
(--strict-mcp-config), restricted mode (file tools confined to the workspace,
command tools only when the agent lists them). Every tool call, built-in or
ours, goes through `can_use_tool` and then the platform's permission gate.
Agents with Claude Code's own tools keep Claude Code's system prompt (the platform's
instructions are appended), and later work continues their saved session
(pae.runtime.sessions), so a step works like a Claude Code session the owner continues.
"""

from __future__ import annotations

import json
import os
import re
import shutil
from collections import defaultdict, deque
from pathlib import Path

from pae.runtime import auto_approve
from pae.runtime.context import LimitExceeded, Outcome, RunContext, RunFailure
from pae.runtime.gate import ToolGate
from pae.runtime.native import build_system_prompt, build_task_message
from pae.runtime.safe_commands import is_safe_command
from pae.subscription import (
    PolicyViolation,
    assert_clean_environment,
    check_credential_source,
    classify_rate_limit,
)
from pae.tools.base import ToolError, blocked_inside, resolve_path

MCP_PREFIX = "mcp__pae__"
BUILTIN_RISK = {
    "Read": "read",
    "Glob": "read",
    "Grep": "read",
    "TodoWrite": "read",
    "Edit": "write",
    "Write": "write",
    "Bash": "execute",
    "WebFetch": "external",
    "WebSearch": "external",
}
BUILTIN_DEFAULT = {"read": "allow", "write": "ask", "execute": "ask", "external": "ask"}
PATH_KEYS = ("file_path", "path", "notebook_path")
# Claude Code edits a project can allow without asking (Bash and others still ask).
TRUSTED_BUILTIN_EDITS = {"Edit", "Write", "MultiEdit", "NotebookEdit"}
OVERLAP = {"fs_list", "fs_read", "fs_search", "fs_write", "shell_run"}
SEARCH_TOOLS = {"Grep", "Glob"}
# How much longer than its time limit a platform tool may take in the CLI's eyes: the time its runs spend waiting
# for the owner. The platform stops the step itself at its own deadline.
MCP_WAIT_ALLOWANCE_S = 24 * 3600
# How long one command may run (Claude Code's own default is 10 minutes): a project's full test suite can take
# longer, and it must run in the foreground (background commands are off, see the session's environment).
LONG_COMMAND_MS = 45 * 60 * 1000
# A session that ends a turn without its report is asked for it, this many times at most.
REPORT_REMINDERS = 2
REPORT_REMINDER = (
    "Your last answer ended without the final report. If the task you were given is not finished, finish it now. "
    "Then send your final report with the StructuredOutput tool, as the task asks."
)
COMMANDS_NOTE = (
    "## Long commands\n"
    "Commands run in the foreground only: background commands are off on this platform. Give a long check, such as "
    f"a project's full test suite, the Bash `timeout` it needs (up to {LONG_COMMAND_MS // 60_000} minutes) and wait "
    "for its result before you report."
)


CONTINUE_NOTE = (
    "[This continues your earlier work in this folder: the conversation above is yours. Files may have changed "
    "since, so read a file again before changing it.]\n\n"
)


def session_prompt(ctx: RunContext) -> str | dict:
    """Agents that work with Claude Code's own tools keep Claude Code's system prompt, the one the owner gets in
    Claude Code (how to search, read, edit, run and check code), with the platform's instructions added after it.
    Other agents only get the platform's instructions."""
    platform_part = build_system_prompt(ctx)
    if ctx.agent.claude_code_tools:
        if "Bash" in ctx.agent.claude_code_tools:
            platform_part += "\n\n" + COMMANDS_NOTE
        return {"type": "preset", "preset": "claude_code", "append": platform_part}
    return platform_part


def find_cli(configured: str | None) -> str | None:
    if configured and Path(configured).is_file():
        return configured
    try:
        import claude_agent_sdk

        bundled = Path(claude_agent_sdk.__file__).parent / "_bundled" / ("claude.exe" if os.name == "nt" else "claude")
        if bundled.is_file():
            return str(bundled)
    except ImportError:
        return None
    return shutil.which("claude")


def search_problem(tool: str, workspace: Path, tool_input: dict) -> str | None:
    """Claude Code's Grep and Glob read everything under the folder they search, so a search may not
    start above a private path, and its file pattern may not leave the folder."""
    file_pattern = str(tool_input.get("glob" if tool == "Grep" else "pattern") or "").replace("\\", "/")
    if ".." in file_pattern.split("/") or file_pattern.startswith("/") or re.match(r"^[A-Za-z]:", file_pattern):
        return "file patterns must stay inside the project folder"
    root = (workspace / str(tool_input.get("path") or ".")).resolve()
    if blocked_inside(root):
        return (
            "this search would include folders the owner made private: "
            "search inside a subfolder that has none of them instead"
        )
    return None


def builtin_permission(ctx: RunContext, tool: str, tool_input: dict) -> tuple[str, str]:
    decision, rule = _builtin_permission(ctx, tool, tool_input)
    command = str(tool_input.get("command") or "")
    if decision == "deny":
        return decision, rule
    if ctx.options.get("read_only"):
        # A read-only task (a diagnosis the app watcher started, with nobody there to approve): it reads files and
        # runs commands that only read; anything else is refused instead of waiting for an approval.
        if BUILTIN_RISK.get(tool, "execute") == "read":
            return decision, rule
        if tool == "Bash" and is_safe_command(command, ctx.workspace, checks=False):
            return "allow", "read-only task"
        return "deny", "read-only task: it changes nothing"
    # The owner's auto-approve mode (like Claude Code's bypass mode), with its few exceptions.
    return auto_approve.decide(ctx, decision, rule, tool, command if tool == "Bash" else None)


def _builtin_permission(ctx: RunContext, tool: str, tool_input: dict) -> tuple[str, str]:
    if tool not in ctx.agent.claude_code_tools:
        return "deny", "not enabled for this agent"
    for key in PATH_KEYS:
        if isinstance(tool_input.get(key), str):
            try:
                resolve_path(ctx.workspace, tool_input[key])
            except ToolError as exc:
                return "deny", str(exc)
    if tool in SEARCH_TOOLS:
        problem = search_problem(tool, ctx.workspace, tool_input)
        if problem:
            return "deny", problem
    owner = ctx.manager.settings.get("permissions.tools", {}).get(f"claude_code.{tool}")
    agent = ctx.agent.permissions.get(f"claude_code.{tool}")
    for value, rule in ((owner, "global"), (agent, "agent")):
        if value == "deny":
            return "deny", rule
    for value, rule in ((owner, "global"), (agent, "agent")):
        if value:
            return value, rule
    if ctx.project_trust_edits and tool in TRUSTED_BUILTIN_EDITS:
        return "allow", "project"
    command = str(tool_input.get("command") or "")
    if ctx.project_trust_edits and tool == "Bash" and is_safe_command(command, ctx.workspace):
        return "allow", "project"  # only reads the project or runs its checks (pae.runtime.safe_commands)
    return BUILTIN_DEFAULT[BUILTIN_RISK.get(tool, "execute")], "default"


async def run_claude_code(ctx: RunContext) -> Outcome:
    try:
        from claude_agent_sdk import (
            AssistantMessage,
            ClaudeAgentOptions,
            ClaudeSDKClient,
            PermissionResultAllow,
            PermissionResultDeny,
            RateLimitEvent,
            ResultMessage,
            SystemMessage,
            TextBlock,
            ThinkingBlock,
            ToolResultBlock,
            ToolUseBlock,
            UserMessage,
            create_sdk_mcp_server,
            tool,
        )
    except ImportError as exc:
        raise RunFailure("claude-agent-sdk is not installed", code="provider_error") from exc

    cli = find_cli(ctx.manager.settings.get("providers.claude_code.cli_path") or ctx.manager.config.claude_code_path)
    if not cli:
        raise RunFailure("Claude Code CLI not found (set providers.claude_code.cli_path)", code="provider_error")

    gate = ToolGate(ctx)
    pending_ids: dict[tuple[str, str], deque] = defaultdict(deque)
    stream_names: dict[str, str] = {}

    def call_key(name: str, payload: dict) -> tuple[str, str]:
        return name, json.dumps(payload, sort_keys=True, default=str)

    def make_handler(tool_name: str):
        async def handler(args: dict) -> dict:
            queue = pending_ids.get(call_key(tool_name, args))
            call_id = queue.popleft() if queue else f"cc_{ctx.tool_calls + 1}"
            result = await gate.execute({"id": call_id, "name": tool_name, "input": args})
            return {"content": [{"type": "text", "text": result["content"]}], "is_error": result["is_error"]}

        return handler

    sdk_tools = []
    # When Claude Code's own file and shell tools are enabled, the overlapping platform
    # tools are left out so the model sees one tool per job.
    skipped = OVERLAP if ctx.agent.claude_code_tools else set()
    for name in ctx.tool_names():
        if name in skipped:
            continue
        platform_tool = ctx.manager.tools.get(name)
        if platform_tool:
            sdk_tools.append(tool(name, platform_tool.description, platform_tool.input_schema)(make_handler(name)))
    server = create_sdk_mcp_server("pae", tools=sdk_tools)

    async def can_use_tool(tool_name: str, tool_input: dict, context):
        if tool_name.startswith(MCP_PREFIX):
            name = tool_name[len(MCP_PREFIX) :]
            if name not in ctx.tool_names():
                return PermissionResultDeny(message=f"{name} is not available to this agent")
            # Permission and approval happen in the platform gate when the tool runs.
            pending_ids[call_key(name, tool_input)].append(context.tool_use_id or f"cc_{ctx.tool_calls + 1}")
            return PermissionResultAllow()
        decision, rule = builtin_permission(ctx, tool_name, tool_input)
        call_id = context.tool_use_id or tool_name
        await ctx.emit(
            "tool.permission",
            "runtime",
            {"tool_call_id": call_id, "tool": f"claude_code.{tool_name}", "decision": decision, "rule": rule},
        )
        if decision == "deny":
            return PermissionResultDeny(message=f"denied by platform policy: {rule}")
        if decision == "ask":
            with ctx.manager.owner_awaited(ctx):  # waiting for the owner does not use up the task's time
                status, note = await ctx.manager.approvals.request(
                    run_id=ctx.run_id,
                    root_run_id=ctx.root_run_id,
                    agent_id=ctx.agent.id,
                    tool=f"claude_code.{tool_name}",
                    tool_call_id=call_id,
                    args=tool_input,
                    risk=BUILTIN_RISK.get(tool_name, "execute"),
                    reason=None,
                    timeout_s=float(ctx.limits["approval_timeout_s"]),
                    on_wait=lambda: ctx.manager.approval_waiting(ctx),
                    on_resume=lambda: ctx.manager.set_status(ctx, "running"),
                )
            if status != "approved":
                return PermissionResultDeny(message=f"the owner did not approve this action ({status}). {note or ''}")
        ctx.tool_calls += 1
        ctx.save_counters()
        await ctx.emit("tool.started", "tool", {"tool_call_id": call_id, "tool": f"claude_code.{tool_name}"})
        return PermissionResultAllow()

    stderr_lines: deque[str] = deque(maxlen=50)
    # Subscription-only: strip every paid credential variable before the CLI starts. The CLI
    # inherits this process's environment, so a stray API key would otherwise be used silently.
    try:
        assert_clean_environment()
    except PolicyViolation as exc:
        raise RunFailure(str(exc), code="policy_violation") from exc
    ctx.manager.check_usage_available()
    env = {
        "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
        # The platform's own Claude Code home: its subscription login (made with `pae claude-login`
        # through Anthropic's sign-in flow), settings and sessions stay apart from the owner's ~/.claude.
        "CLAUDE_CONFIG_DIR": str(ctx.manager.claude_config_dir()),
        # Platform tools can wait for approval or a delegated run, and waiting for the owner does not count against
        # the platform's own time limits: never let the CLI time them out first.
        "MCP_TOOL_TIMEOUT": str(int((float(ctx.limits["timeout_s"]) + MCP_WAIT_ALLOWANCE_S) * 1000)),
        # Every command starts in the project folder, so the platform checks its paths from a known place.
        "CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR": "1",
        # No background commands: a step could end with one still running and lose its result, and a session
        # continued later would first answer that command's leftover "finished" notice, which ended the step at once.
        "CLAUDE_CODE_DISABLE_BACKGROUND_TASKS": "1",
        # Long checks run in the foreground instead (COMMANDS_NOTE); the task's own time limit still applies.
        "BASH_MAX_TIMEOUT_MS": str(LONG_COMMAND_MS),
    }
    tools_bin = ctx.manager.tools_bin()
    if tools_bin:  # last on the PATH: a project's own python, pip and pytest always come first
        env["PATH"] = os.environ.get("PATH", "") + os.pathsep + str(tools_bin)
    options = ClaudeAgentOptions(
        cli_path=cli,
        cwd=str(ctx.workspace),
        system_prompt=session_prompt(ctx),
        tools=list(ctx.agent.claude_code_tools),
        allowed_tools=[],
        mcp_servers={"pae": server},
        strict_mcp_config=True,
        setting_sources=[],
        permission_mode="default",
        can_use_tool=can_use_tool,
        model=ctx.model or None,
        max_turns=int(ctx.limits["max_steps"]),
        effort=ctx.agent.effort,
        output_format={"type": "json_schema", "schema": ctx.agent.output_schema} if ctx.agent.output_schema else None,
        # Sessions are saved in the platform's Claude Code home so later work can continue them
        # (pae.runtime.sessions). A continuation is a fork: the earlier session itself is never changed.
        resume=ctx.continue_session,
        fork_session=bool(ctx.continue_session),
        extra_args={"restricted": None},
        stderr=lambda line: stderr_lines.append(line),
        env=env,
    )

    prompt = build_task_message(ctx)["content"][0]["text"]
    if ctx.continue_session:
        prompt = CONTINUE_NOTE + prompt
        await ctx.emit(
            "runtime.note",
            "runtime",
            {
                "message": "Continues its earlier session in this folder: what it already read is kept",
                "continues_run_id": ctx.continue_from_run,
            },
        )
    seen_messages: set[str] = set()
    # Tokens counted message by message, so a step that is stopped (cancelled, timed out) still shows what it used;
    # the session's own total replaces this count when it ends normally.
    base_tokens = (ctx.input_tokens, ctx.output_tokens)
    live_usage: dict[str, tuple[int, int]] = {}
    actual_model: dict[str, str | None] = {"name": None}
    final_text: list[str] = []

    async def receive(client) -> ResultMessage | None:
        """Handle one answer of the session, up to its result message."""
        received = None
        async for message in client.receive_response():
            if isinstance(message, SystemMessage) and message.subtype == "init":
                data = message.data or {}
                if data.get("model"):
                    actual_model["name"] = data["model"]
                    ctx.manager.update_run(ctx.run_id, model=data["model"])
                if isinstance(data.get("session_id"), str):  # saved at once: a stopped step can be continued
                    ctx.manager.update_run(ctx.run_id, claude_session_id=data["session_id"][:64])
                try:
                    check_credential_source(data.get("apiKeySource"))
                except PolicyViolation as exc:
                    await ctx.emit("runtime.note", "runtime", {"message": str(exc), "policy": "violation"})
                    raise RunFailure(str(exc), code="policy_violation") from exc
                await ctx.emit(
                    "runtime.note",
                    "runtime",
                    {
                        "message": "Claude Code session started",
                        "model": data.get("model"),
                        "tools": data.get("tools"),
                        "claude_code_version": data.get("claude_code_version"),
                        "auth_method": "claude.ai subscription",
                        "api_key_source": data.get("apiKeySource"),  # "none" = claude.ai login
                        "permission_mode": data.get("permissionMode"),
                    },
                )
            elif isinstance(message, SystemMessage) and message.subtype == "api_retry":
                data = message.data or {}
                await ctx.emit(
                    "model.retry",
                    "runtime",
                    {
                        "attempt": data.get("attempt"),
                        "error": data.get("error"),
                        "status": data.get("error_status"),
                        "retry_in_s": round((data.get("retry_delay_ms") or 0) / 1000, 2),
                    },
                )
            elif isinstance(message, RateLimitEvent):
                await handle_usage_signal(ctx, message.rate_limit_info)
            elif isinstance(message, AssistantMessage):
                new_message = bool(message.message_id) and message.message_id not in seen_messages
                if new_message:
                    seen_messages.add(message.message_id)
                    ctx.steps += 1
                if count_live_usage(ctx, message, live_usage, base_tokens) or new_message:
                    ctx.save_counters()
                if new_message:
                    await ctx.emit("step.started", "runtime", {"step": ctx.steps, "model": message.model})
                for block in message.content:
                    if isinstance(block, TextBlock) and block.text.strip():
                        final_text.append(block.text)
                        await ctx.emit("agent.message", "agent", {"text": block.text})
                    elif isinstance(block, ThinkingBlock) and block.thinking.strip():
                        await ctx.emit("agent.reasoning", "agent", {"text": block.thinking, "kind": "provider_summary"})
                    elif isinstance(block, ToolUseBlock):
                        name = (
                            block.name[len(MCP_PREFIX) :]
                            if block.name.startswith(MCP_PREFIX)
                            else f"claude_code.{block.name}"
                        )
                        stream_names[block.id] = name
                        await ctx.emit(
                            "agent.tool_call",
                            "agent",
                            {"tool_call_id": block.id, "tool": name, "input": block.input},
                        )
            elif isinstance(message, UserMessage) and isinstance(message.content, list):
                for block in message.content:
                    if isinstance(block, ToolResultBlock):
                        name = stream_names.get(block.tool_use_id, "")
                        if name.startswith("claude_code."):  # platform tools emit their own events
                            text = _result_text(block.content)
                            await ctx.emit(
                                "tool.failed" if block.is_error else "tool.completed",
                                "tool",
                                {
                                    "tool_call_id": block.tool_use_id,
                                    "tool": name,
                                    "output": ctx.manager.redactor.text(text[:8000]),
                                    **({"error": text[:2000]} if block.is_error else {}),
                                },
                            )
            elif isinstance(message, ResultMessage):
                received = message
        return received

    result_message = None
    try:
        async with ClaudeSDKClient(options=options) as client:
            await client.query(prompt)
            result_message = await receive(client)
            # The session ended its turn without the report the agent owes (it answered something else first,
            # or just stopped): ask for it in the same session instead of throwing the work away.
            for _ in range(REPORT_REMINDERS):
                if not report_missing(ctx, result_message):
                    break
                note = "The session ended without its report: the platform asked for it again"
                await ctx.emit("runtime.note", "runtime", {"message": note})
                await client.query(REPORT_REMINDER)
                again = await receive(client)
                if again is None:
                    break
                result_message = again
    except RunFailure:
        raise
    except Exception as exc:
        detail = " | ".join(list(stderr_lines)[-5:])
        raise RunFailure(
            f"Claude Code session failed: {type(exc).__name__}: {exc} {detail}".strip(), code="provider_error"
        ) from exc

    if result_message is None:
        raise RunFailure("Claude Code ended without a result", code="provider_error")
    if isinstance(result_message.session_id, str) and result_message.session_id:
        ctx.manager.update_run(ctx.run_id, claude_session_id=result_message.session_id[:64])
    usage = result_message.usage or {}
    # New tokens only. Each turn re-reads the whole conversation from cache (cache_read_input_tokens): over a
    # long session that grows into millions without being new work. The event below keeps every count.
    # The session's own total, or the count kept message by message when that is larger (a session asked again for
    # its report gives a result per answer).
    live = (ctx.input_tokens - base_tokens[0], ctx.output_tokens - base_tokens[1])
    ctx.input_tokens = base_tokens[0] + max(live[0], new_input_tokens(usage))
    ctx.output_tokens = base_tokens[1] + max(live[1], int(usage.get("output_tokens", 0) or 0))
    ctx.cost_usd += float(result_message.total_cost_usd or 0.0)
    ctx.save_counters()
    await ctx.emit(
        "model.response",
        "runtime",
        {
            "provider": "claude-code",
            "model": actual_model["name"] or ctx.model or "plan default",
            "stop_reason": result_message.subtype,
            "duration_ms": result_message.duration_ms,
            "usage": usage,
            "cost_usd": result_message.total_cost_usd,
            "cost_estimated": True,
            "cost_note": "API-equivalent estimate reported by Claude Code; covered by your subscription, not billed",
            "turns": result_message.num_turns,
            "model_usage": result_message.model_usage,
            "duration_api_ms": result_message.duration_api_ms,
        },
    )
    # Usage is only known once the session has ended: by then the work is done, so going past a usage limit
    # is reported, not turned into a failure that would throw the work away. Turns and time stop a session.
    for name, value, maximum in ctx.limits_over():
        await ctx.emit(
            "runtime.note",
            "runtime",
            {"message": f"This step used more than its limit ({name} = {value}, max {maximum}); its result is kept."},
        )
    if result_message.subtype == "error_max_turns":
        maximum, turns = int(ctx.limits["max_steps"]), result_message.num_turns
        await ctx.emit("limit.exceeded", "runtime", {"limit": "max_steps", "value": turns, "max": maximum})
        raise LimitExceeded("max_steps", turns, maximum)
    if result_message.is_error:
        detail = result_message.result or "; ".join(map(str, result_message.errors or [])) or result_message.subtype
        lowered = detail.lower()
        if "authenticate" in lowered or "oauth" in lowered or "login" in lowered:
            detail += (
                " -- The platform's Claude Code is not signed in to your subscription. Run `pae claude-login` "
                "in a terminal and complete Anthropic's sign-in with your Claude account."
            )
            raise RunFailure(f"Claude Code reported an error: {detail}", code="not_signed_in")
        if "usage limit" in lowered or "rate limit" in lowered:
            raise RunFailure(f"Claude Code reported an error: {detail}", code="usage_limit")
        raise RunFailure(f"Claude Code reported an error: {detail}", code="provider_error")
    if ctx.agent.output_schema:
        if result_message.structured_output is None:
            raise RunFailure("Claude Code returned no structured output", code="no_final_answer")
        await ctx.emit("agent.final", "agent", {"output": result_message.structured_output})
        return Outcome(output=result_message.structured_output, output_text=result_message.result)
    text = result_message.result or "\n".join(final_text)
    await ctx.emit("agent.final", "agent", {"output_text": text})
    return Outcome(output=None, output_text=text)


def report_missing(ctx: RunContext, result) -> bool:
    """The session ended a turn normally, but without the structured report this agent owes."""
    return bool(
        ctx.agent.output_schema
        and result is not None
        and not result.is_error
        and result.subtype != "error_max_turns"
        and result.structured_output is None
    )


def new_input_tokens(usage: dict) -> int:
    return int(usage.get("input_tokens", 0) or 0) + int(usage.get("cache_creation_input_tokens", 0) or 0)


def count_live_usage(ctx: RunContext, message, live: dict[str, tuple[int, int]], base: tuple[int, int]) -> bool:
    """Add one model message's tokens to the step's counters. One message arrives in several parts that repeat its
    usage, so each message counts once, with its largest figures. Returns True when the counters changed."""
    usage = getattr(message, "usage", None)
    if not isinstance(usage, dict) or not message.message_id:
        return False
    before = live.get(message.message_id, (0, 0))
    now = (
        max(before[0], new_input_tokens(usage)),
        max(before[1], int(usage.get("output_tokens", 0) or 0)),
    )
    if now == before:
        return False
    live[message.message_id] = now
    ctx.input_tokens = base[0] + sum(tokens[0] for tokens in live.values())
    ctx.output_tokens = base[1] + sum(tokens[1] for tokens in live.values())
    return True


def _result_text(content) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(c.get("text", "") for c in content if isinstance(c, dict))
    return ""


async def handle_usage_signal(ctx: RunContext, info) -> None:
    """Report subscription usage state; stop the run at the plan limit so no usage credits are spent."""
    signal = classify_rate_limit(info)
    if signal.action == "ok":
        return
    data = {
        "status": signal.action,
        "overage_status": signal.overage_status,
        "window": signal.window,
        "utilization": signal.utilization,
        "resets_at": signal.resets_at.isoformat() if signal.resets_at else None,
        "message": signal.message,
    }
    await ctx.emit("usage.limit", "runtime", data)
    if signal.action in ("stop_limit", "stop_overage"):
        ctx.manager.record_usage_block(signal)
        code = "overage_blocked" if signal.action == "stop_overage" else "usage_limit"
        until = f" until {signal.resets_at.isoformat()}" if signal.resets_at else ""
        raise RunFailure(f"Subscription usage: {signal.message}{until}.", code=code)
