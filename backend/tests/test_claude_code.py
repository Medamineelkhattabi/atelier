"""The claude-code provider adapter, driven by a fake Claude Agent SDK client.

The fake plays the CLI's role: it asks `can_use_tool`, invokes the platform's MCP
tool handlers and streams SDK messages. Everything on the platform side is real.
"""

from __future__ import annotations

import asyncio
import os

import claude_agent_sdk as sdk
import pytest

from conftest import events_of, wait_event, wait_for

pytestmark = pytest.mark.anyio


class FakeClient:
    """Replays a scenario: a list of async steps, each yielding zero or more SDK messages."""

    scenario = None
    last_options = None
    last_prompt = None  # the task
    prompts: list[str] = []  # the task, then anything the platform asked afterwards

    def __init__(self, options):
        FakeClient.last_options = options
        FakeClient.prompts = []
        self.options = options
        self.steps = iter(FakeClient.scenario)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def query(self, prompt: str) -> None:
        if not FakeClient.prompts:
            FakeClient.last_prompt = prompt
        FakeClient.prompts.append(prompt)

    async def receive_response(self):
        """One answer: the scenario's next steps, up to a result message (like the SDK)."""
        for step in self.steps:
            for message in await step(self.options):
                yield message
                if isinstance(message, sdk.ResultMessage):
                    return


@pytest.fixture
def fake_sdk(monkeypatch, tmp_path):
    captured = {}

    def fake_server(name, version="1.0.0", tools=None):
        captured["tools"] = {t.name: t for t in tools or []}
        return {"type": "sdk", "name": name}

    cli = tmp_path / ("claude.exe" if os.name == "nt" else "claude")
    cli.write_text("fake")
    monkeypatch.setattr(sdk, "ClaudeSDKClient", FakeClient)
    monkeypatch.setattr(sdk, "create_sdk_mcp_server", fake_server)
    return {"captured": captured, "cli": str(cli)}


def ctx(tool_use_id: str) -> sdk.ToolPermissionContext:
    return sdk.ToolPermissionContext(tool_use_id=tool_use_id)


def result(**kwargs) -> sdk.ResultMessage:
    base = dict(
        subtype="success",
        duration_ms=12,
        duration_api_ms=10,
        is_error=False,
        num_turns=2,
        session_id="s",
        total_cost_usd=0.0123,
        usage={"input_tokens": 100, "output_tokens": 20},
    )
    base.update(kwargs)
    return sdk.ResultMessage(**base)


async def setup_agent(platform, fake_sdk, **overrides):
    platform.settings.set("providers.claude_code.cli_path", fake_sdk["cli"])
    platform.registry.save_custom(
        {
            "id": "coder",
            "name": "Coder",
            "description": "cc test",
            "provider": "claude-code",
            "instructions": "Code.",
            "tools": ["fs_read", "doc_extract_text", "git_status"],
            "claude_code_tools": ["Read", "Edit"],
            "output_schema": {"type": "object", "required": ["answer"], "properties": {"answer": {"type": "string"}}},
            **overrides,
        },
        create=True,
    )


async def test_claude_code_events_tools_and_structured_output(platform, fake_sdk, monkeypatch):
    await setup_agent(platform, fake_sdk)
    workspace = platform.config.default_workspace
    workspace.mkdir(parents=True, exist_ok=True)
    (workspace / "a.txt").write_text("hello from a")
    # A stray API key in the environment must never reach Claude Code (it would bill silently in -p mode).
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-api03-claudecodekey99")
    monkeypatch.setenv("CLAUDE_CODE_USE_BEDROCK", "1")
    seen: dict = {}

    async def init(options):
        return [
            sdk.SystemMessage(
                subtype="init",
                data={"model": "claude-opus-5-5", "apiKeySource": "none", "tools": ["mcp__pae__fs_read"]},
            )
        ]

    async def platform_tool(options):
        decision = await options.can_use_tool("mcp__pae__doc_extract_text", {"path": "a.txt"}, ctx("tu1"))
        assert isinstance(decision, sdk.PermissionResultAllow)
        seen["tool_result"] = await fake_sdk["captured"]["tools"]["doc_extract_text"].handler({"path": "a.txt"})
        return [
            sdk.AssistantMessage(
                content=[
                    sdk.TextBlock("Reading a.txt"),
                    sdk.ToolUseBlock(id="tu1", name="mcp__pae__doc_extract_text", input={"path": "a.txt"}),
                ],
                model="m",
                message_id="m1",
            )
        ]

    async def builtin_checks(options):
        seen["bash"] = await options.can_use_tool("Bash", {"command": "rm -rf /"}, ctx("tu2"))
        seen["outside"] = await options.can_use_tool("Read", {"file_path": "../../x.txt"}, ctx("tu3"))
        seen["read"] = await options.can_use_tool("Read", {"file_path": "a.txt"}, ctx("tu4"))
        return [
            sdk.AssistantMessage(
                content=[sdk.ToolUseBlock(id="tu4", name="Read", input={"file_path": "a.txt"})],
                model="m",
                message_id="m2",
            ),
            sdk.UserMessage(content=[sdk.ToolResultBlock(tool_use_id="tu4", content="hello from a")]),
        ]

    async def finish(options):
        return [result(structured_output={"answer": "done"}, result="done")]

    FakeClient.scenario = [init, platform_tool, builtin_checks, finish]
    run_id = await platform.manager.submit(task="read a.txt", agent_id="coder")
    run = await wait_for(platform, run_id)
    assert run["status"] == "completed", run["error"]
    assert run["output"] == {"answer": "done"} and run["steps"] == 2
    assert run["cost_usd"] == pytest.approx(0.0123) and run["input_tokens"] == 100

    options = FakeClient.last_options
    assert options.setting_sources == [] and options.strict_mcp_config is True
    assert options.tools == ["Read", "Edit"] and options.allowed_tools == []
    assert "restricted" in options.extra_args and "bare" not in options.extra_args  # bare mode ignores the login
    assert not any(k.startswith(("ANTHROPIC_", "CLAUDE_CODE_USE_")) for k in options.env)
    assert "ANTHROPIC_API_KEY" not in os.environ and "CLAUDE_CODE_USE_BEDROCK" not in os.environ
    assert options.env["CLAUDE_CONFIG_DIR"] == str(platform.manager.claude_config_dir())
    assert int(options.env["MCP_TOOL_TIMEOUT"]) >= 60_000
    # Overlapping platform tools are not mounted when Claude Code's own file tools are enabled.
    assert set(fake_sdk["captured"]["tools"]) == {"doc_extract_text", "git_status"}

    assert "hello from a" in seen["tool_result"]["content"][0]["text"]
    assert isinstance(seen["bash"], sdk.PermissionResultDeny)
    assert isinstance(seen["outside"], sdk.PermissionResultDeny) and "outside" in seen["outside"].message
    assert isinstance(seen["read"], sdk.PermissionResultAllow)

    events = platform.manager.bus.history(root_run_id=run_id)
    types = [e["type"] for e in events]
    started = next(e for e in events if e["type"] == "runtime.note" and "auth_method" in e["data"])
    assert started["data"]["auth_method"] == "claude.ai subscription" and started["data"]["api_key_source"] == "none"
    assert run["model"] == "claude-opus-5-5"  # the model Claude Code reported, not "plan default"
    response = next(e for e in events if e["type"] == "model.response")
    assert response["data"]["model"] == "claude-opus-5-5"
    assert "agent.tool_call" in types and "tool.completed" in types and "agent.final" in types
    assert "sk-ant-api03-claudecodekey99" not in str(events)


async def test_claude_code_edit_needs_approval(platform, fake_sdk):
    await setup_agent(platform, fake_sdk)
    seen = {}

    async def edit(options):
        seen["edit"] = await options.can_use_tool(
            "Edit", {"file_path": "b.txt", "old_string": "a", "new_string": "b"}, ctx("tu9")
        )
        return []

    FakeClient.scenario = [edit, lambda options: _done()]
    run_id = await platform.manager.submit(task="edit b.txt", agent_id="coder")
    requested = await wait_event(platform, run_id, "approval.requested")
    assert requested["data"]["tool"] == "claude_code.Edit"
    await platform.manager.approvals.decide(requested["data"]["approval_id"], False, "no edits", "owner")
    await wait_for(platform, run_id)
    assert isinstance(seen["edit"], sdk.PermissionResultDeny) and "did not approve" in seen["edit"].message


async def _done():
    await asyncio.sleep(0)
    return [result(structured_output={"answer": "ok"})]


async def test_a_session_that_ends_without_its_report_is_asked_for_it(platform, fake_sdk):
    await setup_agent(platform, fake_sdk)

    async def leftover(options):  # e.g. the session first answered a leftover notice: a result, but not the task's
        return [sdk.AssistantMessage(content=[sdk.TextBlock("No response requested.")], model="m", message_id="m0"),
                result()]  # fmt: skip

    async def the_task(options):
        return [result(structured_output={"answer": "done after all"})]

    FakeClient.scenario = [leftover, the_task]
    run_id = await platform.manager.submit(task="change the page", agent_id="coder")
    run = await wait_for(platform, run_id)
    assert run["status"] == "completed", run["error"]  # before: failed, "Claude Code returned no structured output"
    assert run["output"] == {"answer": "done after all"}
    assert len(FakeClient.prompts) == 2 and "final report" in FakeClient.prompts[1]
    assert "change the page" in FakeClient.last_prompt
    notes = [e["data"]["message"] for e in events_of(platform, run_id, "runtime.note")]
    assert any("asked for it again" in note for note in notes)

    # A session that never reports is asked twice, then the step fails as before.
    FakeClient.scenario = [lambda options: _silent(), lambda options: _silent(), lambda options: _silent()]
    never = await wait_for(platform, await platform.manager.submit(task="again", agent_id="coder"))
    assert never["status"] == "failed" and "no structured output" in never["error"]
    assert len(FakeClient.prompts) == 3


async def _silent():
    await asyncio.sleep(0)
    return [result()]


def said(message_id: str, **usage) -> sdk.AssistantMessage:
    return sdk.AssistantMessage(content=[sdk.TextBlock("working")], model="m", message_id=message_id, usage=usage)


async def test_a_stopped_step_keeps_the_tokens_it_used(platform, fake_sdk):
    await setup_agent(platform, fake_sdk)

    async def work(options):
        # One message arrives in parts that repeat its usage: it counts once. Cache re-reads are not new tokens.
        return [
            said("m1", input_tokens=10, cache_creation_input_tokens=1000, output_tokens=5),
            said("m1", input_tokens=10, cache_creation_input_tokens=1000, output_tokens=40),
            said("m2", input_tokens=3, cache_creation_input_tokens=200, cache_read_input_tokens=9000, output_tokens=60),
        ]

    async def forever(options):
        await asyncio.Event().wait()
        return []

    FakeClient.scenario = [work, forever]
    run_id = await platform.manager.submit(task="long work", agent_id="coder")
    await wait_event(platform, run_id, "step.started")
    for _ in range(100):
        if (await wait_for(platform, run_id, statuses=("running",)))["output_tokens"] == 100:
            break
        await asyncio.sleep(0.02)
    await platform.manager.cancel(run_id)
    run = await wait_for(platform, run_id)
    assert run["status"] == "cancelled"
    assert (run["input_tokens"], run["output_tokens"]) == (1213, 100), "before, a stopped step showed 0"


async def test_the_sessions_own_total_replaces_the_live_count(platform, fake_sdk):
    await setup_agent(platform, fake_sdk)

    async def work(options):
        return [said("m1", input_tokens=7, output_tokens=8), result(structured_output={"answer": "ok"})]

    FakeClient.scenario = [work]
    run_id = await platform.manager.submit(task="short work", agent_id="coder")
    run = await wait_for(platform, run_id)
    assert run["status"] == "completed", run["error"]
    assert (run["input_tokens"], run["output_tokens"]) == (100, 20)


async def test_claude_code_auth_error_explains_the_fix(platform, fake_sdk):
    await setup_agent(platform, fake_sdk)

    async def fail(options):
        return [result(is_error=True, result="Failed to authenticate: OAuth session expired")]

    FakeClient.scenario = [fail]
    run_id = await platform.manager.submit(task="anything", agent_id="coder")
    run = await wait_for(platform, run_id)
    assert run["status"] == "failed" and "pae claude-login" in run["error"]


async def test_a_long_session_keeps_its_work_and_only_new_tokens_count(platform, fake_sdk):
    # A real 31-turn coding step: 2.9M tokens re-read from cache, 0.2M new. Usage is known only at the end.
    usage = {
        "input_tokens": 60,
        "cache_creation_input_tokens": 158_524,
        "cache_read_input_tokens": 2_898_652,
        "output_tokens": 58_338,
    }

    async def done(options):
        return [result(num_turns=31, usage=usage, total_cost_usd=30.0, structured_output={"answer": "ok"})]

    run_id, run = await run_scenario(platform, fake_sdk, [done])
    assert run["status"] == "completed", run["error"]
    assert run["input_tokens"] == 158_584 and run["output_tokens"] == 58_338
    notes = [e["data"]["message"] for e in events_of(platform, run_id, "runtime.note")]
    assert any("max_cost_usd" in n and "result is kept" in n for n in notes), "going past a limit is reported"


async def test_a_session_out_of_turns_says_so(platform, fake_sdk):
    async def out_of_turns(options):
        return [result(subtype="error_max_turns", is_error=True, num_turns=151)]

    run_id, run = await run_scenario(platform, fake_sdk, [out_of_turns])
    assert run["status"] == "failed" and run["error"] == "limit exceeded: max_steps = 151 (max 150)"
    assert FakeClient.last_options.max_turns == 150, "the default fits real coding work"


async def run_scenario(platform, fake_sdk, steps, task="anything"):
    await setup_agent(platform, fake_sdk)
    FakeClient.scenario = steps
    run_id = await platform.manager.submit(task=task, agent_id="coder")
    return run_id, await wait_for(platform, run_id)


async def test_session_on_an_api_key_is_stopped_before_any_work(platform, fake_sdk):
    reached = []

    async def init(options):
        return [sdk.SystemMessage(subtype="init", data={"apiKeySource": "ANTHROPIC_API_KEY"})]

    async def work(options):
        reached.append(True)
        return [result(structured_output={"answer": "should not happen"})]

    run_id, run = await run_scenario(platform, fake_sdk, [init, work])
    assert run["status"] == "failed" and "subscription" in run["error"] and not reached
    for source in ("apiKeyHelper", "/login managed key"):
        from pae.subscription import PolicyViolation, check_credential_source

        with pytest.raises(PolicyViolation):
            check_credential_source(source)


def rate_limit(status, window, overage=None, resets=4_102_444_800):
    info = sdk.RateLimitInfo(
        status=status, rate_limit_type=window, overage_status=overage, resets_at=resets, utilization=0.97
    )
    return sdk.RateLimitEvent(rate_limit_info=info, uuid="u", session_id="s")


async def test_plan_limit_stops_the_run_and_blocks_new_runs(platform, fake_sdk):
    async def limited(options):
        return [rate_limit("rejected", "five_hour")]

    run_id, run = await run_scenario(platform, fake_sdk, [limited])
    assert run["status"] == "failed" and "five_hour" in run["error"]
    events = platform.manager.bus.history(root_run_id=run_id)
    assert any(e["type"] == "usage.limit" and e["data"]["status"] == "stop_limit" for e in events)
    assert platform.manager.usage_state()["blocked_until"].startswith("2100-01-01")
    with pytest.raises(ValueError, match="usage limit"):
        await platform.manager.submit(task="next", agent_id="coder")
    platform.manager.clear_usage_block()
    assert platform.manager.usage_state() is None


async def test_paid_overage_is_never_used(platform, fake_sdk):
    async def overage(options):
        return [rate_limit("allowed", "overage", overage="allowed")]

    async def work(options):
        raise AssertionError("the run must stop before more work")

    run_id, run = await run_scenario(platform, fake_sdk, [overage, work])
    assert run["status"] == "failed" and "usage credits" in run["error"]
    assert platform.manager.usage_state()["reason"] == "overage"


async def test_usage_warning_is_reported_and_the_run_continues(platform, fake_sdk):
    async def warning(options):
        return [rate_limit("allowed_warning", "seven_day")]

    run_id, run = await run_scenario(platform, fake_sdk, [warning, lambda options: _done()])
    assert run["status"] == "completed"
    events = platform.manager.bus.history(root_run_id=run_id)
    warning = next(e for e in events if e["type"] == "usage.limit")
    assert warning["data"]["status"] == "warn" and "overage_status" in warning["data"]
    assert platform.manager.usage_state() is None


def session(session_id: str):
    """A Claude Code session that starts as `session_id` and ends normally."""

    async def init(options):
        return [
            sdk.SystemMessage(subtype="init", data={"model": "m", "apiKeySource": "none", "session_id": session_id})
        ]

    async def done(options):
        return [result(session_id=session_id, structured_output={"answer": "ok"})]

    return [init, done]


def saved(platform, session_id: str):
    """What Claude Code leaves on disk for a session it saved: its transcript."""
    path = platform.manager.claude_config_dir() / "projects" / "ws" / f"{session_id}.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("{}\n")
    return path


async def test_commands_run_in_the_foreground_with_room_for_a_full_test_suite(platform, fake_sdk):
    await setup_agent(platform, fake_sdk, claude_code_tools=["Read", "Edit", "Bash"])
    FakeClient.scenario = session("abcd8888-0001")
    run = await wait_for(platform, await platform.manager.submit(task="run the tests", agent_id="coder"))
    assert run["status"] == "completed", run["error"]
    options = FakeClient.last_options
    # Before, a step left its 15-minute test suite running in the background, ended without its result, and the
    # session continued later first answered the leftover notice, which ended that step at once.
    assert options.env["CLAUDE_CODE_DISABLE_BACKGROUND_TASKS"] == "1"
    assert int(options.env["BASH_MAX_TIMEOUT_MS"]) >= 30 * 60 * 1000
    assert "## Long commands" in options.system_prompt["append"] and "foreground" in options.system_prompt["append"]

    reader = {"id": "reader", "name": "Reader", "description": "cc test", "provider": "claude-code",
              "instructions": "Read.", "claude_code_tools": ["Read"]}  # fmt: skip
    platform.registry.save_custom(reader, create=True)  # without Bash, no word about commands
    FakeClient.scenario = session("abcd8888-0002")
    await wait_for(platform, await platform.manager.submit(task="read", agent_id="reader"))
    assert "## Long commands" not in FakeClient.last_options.system_prompt["append"]
    assert FakeClient.last_options.env["CLAUDE_CODE_DISABLE_BACKGROUND_TASKS"] == "1"


async def test_coding_agents_keep_claude_codes_own_way_of_working(platform, fake_sdk):
    run_id, run = await run_scenario(platform, fake_sdk, session("aaaa1111-0000"))
    assert run["status"] == "completed", run["error"]
    prompt = FakeClient.last_options.system_prompt
    # The system prompt the owner gets in Claude Code, with the platform's instructions after it.
    assert prompt["type"] == "preset" and prompt["preset"] == "claude_code" and "Code." in prompt["append"]
    assert "no-session-persistence" not in FakeClient.last_options.extra_args, "sessions are saved to be continued"
    assert FakeClient.last_options.resume is None, "a first task starts a new session"

    platform.registry.save_custom(
        {
            "id": "writer",
            "name": "Writer",
            "description": "no code tools",
            "provider": "claude-code",
            "instructions": "Write.",
            "tools": ["fs_read"],
        },
        create=True,
    )
    FakeClient.scenario = session("bbbb2222-0000")
    await wait_for(platform, await platform.manager.submit(task="write", agent_id="writer"))
    assert isinstance(FakeClient.last_options.system_prompt, str), "agents without code tools keep only their own"


async def test_a_follow_up_continues_the_earlier_session(platform, fake_sdk):
    first, run = await run_scenario(platform, fake_sdk, session("aaaa1111-0001"))
    assert run["status"] == "completed", run["error"]
    with platform.db.session() as s:
        from pae.db import Run

        assert s.get(Run, first).claude_session_id == "aaaa1111-0001", "the session is saved as soon as it starts"
    saved(platform, "aaaa1111-0001")

    FakeClient.scenario = session("aaaa1111-0002")
    second = await platform.manager.submit(task="now add the tests", agent_id="coder", options={"follow_up_of": first})
    assert (await wait_for(platform, second))["status"] == "completed"
    options = FakeClient.last_options
    assert options.resume == "aaaa1111-0001" and options.fork_session is True, "continued as a fork"
    assert FakeClient.last_prompt.startswith("[This continues your earlier work")
    notes = events_of(platform, second, "runtime.note")
    assert any(n["data"].get("continues_run_id") == first for n in notes)

    # A follow-up of the follow-up continues the newest session of that agent.
    saved(platform, "aaaa1111-0002")
    FakeClient.scenario = session("aaaa1111-0003")
    third = await platform.manager.submit(task="and the docs", agent_id="coder", options={"follow_up_of": second})
    await wait_for(platform, third)
    assert FakeClient.last_options.resume == "aaaa1111-0002"


async def test_a_session_is_never_shared_between_agents_or_continued_once_gone(platform, fake_sdk):
    first, _run = await run_scenario(platform, fake_sdk, session("cccc3333-0001"))
    # Its transcript was never saved (or was deleted): the follow-up starts a new session.
    FakeClient.scenario = session("cccc3333-0002")
    await wait_for(
        platform, await platform.manager.submit(task="more", agent_id="coder", options={"follow_up_of": first})
    )
    assert FakeClient.last_options.resume is None

    saved(platform, "cccc3333-0001")
    platform.registry.save_custom(
        {
            "id": "reviewer",
            "name": "Reviewer",
            "description": "cc",
            "provider": "claude-code",
            "instructions": "Review.",
            "tools": ["fs_read"],
            "claude_code_tools": ["Read"],
        },
        create=True,
    )
    FakeClient.scenario = session("cccc3333-0003")
    await wait_for(
        platform, await platform.manager.submit(task="review", agent_id="reviewer", options={"follow_up_of": first})
    )
    assert FakeClient.last_options.resume is None, "another team member always starts its own session"


async def test_a_step_in_the_same_task_continues_the_stopped_attempt(platform, fake_sdk):
    from pae.db import Run
    from pae.runtime.sessions import session_to_continue

    await setup_agent(platform, fake_sdk)
    config_dir = platform.manager.claude_config_dir()
    saved(platform, "dddd4444-0001")
    with platform.db.session() as s:
        root = Run(kind="agent", agent_id="orchestrator", status="running", task="t", root_run_id="r", workspace="w")
        s.add(root)
        s.flush()
        root.root_run_id = root.id

        def child(agent, status, session_id=None):
            run = Run(
                kind="agent",
                agent_id=agent,
                status=status,
                task="t",
                root_run_id=root.id,
                parent_run_id=root.id,
                workspace="w",
                claude_session_id=session_id,
            )
            s.add(run)
            s.flush()
            return run

        stopped = child("coder", "failed", "dddd4444-0001")  # ran out of turns
        retry, review = child("coder", "queued"), child("reviewer", "queued")
        elsewhere = Run(
            kind="agent",
            agent_id="coder",
            status="queued",
            task="t",
            root_run_id=root.id,
            parent_run_id=root.id,
            workspace="other",
        )
        s.add(elsewhere)
        s.flush()
        assert session_to_continue(s, retry, config_dir) == ("dddd4444-0001", stopped.id)
        assert session_to_continue(s, review, config_dir) is None
        assert session_to_continue(s, elsewhere, config_dir) is None, "only in the same folder"
        assert session_to_continue(s, stopped, config_dir) == ("dddd4444-0001", stopped.id), "resumed: its own"


async def test_deleting_or_expiring_a_task_deletes_its_saved_sessions(platform, fake_sdk):
    first, _run = await run_scenario(platform, fake_sdk, session("eeee5555-0001"))
    transcript = saved(platform, "eeee5555-0001")
    (transcript.with_suffix("") / "tool-results").mkdir(parents=True)
    assert platform.purge_expired(days=0) == 1
    assert not transcript.exists() and not transcript.with_suffix("").exists()


async def test_the_team_addresses_the_owner_by_name_not_the_accounts(platform, fake_sdk):
    platform.settings.set("owner.name", "Ada Lovelace")
    _run_id, run = await run_scenario(platform, fake_sdk, session("ffff6666-0001"))
    assert run["status"] == "completed", run["error"]
    prompt = FakeClient.last_options.system_prompt["append"]
    assert "You work for Ada Lovelace" in prompt and "may show another name" in prompt


async def test_sessions_find_the_security_scanners_after_the_projects_own_commands(platform, fake_sdk):
    tools_bin = platform.config.data_dir / "tools" / "bin"
    tools_bin.mkdir(parents=True)
    _run_id, run = await run_scenario(platform, fake_sdk, session("abcd7777-0001"))
    assert run["status"] == "completed", run["error"]
    path = FakeClient.last_options.env["PATH"].split(os.pathsep)
    assert path[-1] == str(tools_bin) and path[:-1] == os.environ.get("PATH", "").split(os.pathsep)
