"""Team members on an ACP agent (pae.runtime.acp), against a scripted ACP agent (tests/fake_acp_agent.py): no model,
no network, no real agent installed."""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

import httpx
import pytest

from pae.app import create_app
from pae.engines import CATALOG, engines_problem
from pae.providers.base import ProviderNotConfigured
from pae.runtime.manager import SubmitError
from pae.subscription import agent_environment, is_allowed_provider

from conftest import OUTPUT_SCHEMA, events_of, wait_event, wait_for

pytestmark = pytest.mark.anyio

FAKE = Path(__file__).with_name("fake_acp_agent.py")


def use_fake_agent(platform, tmp_path: Path, scenario: dict, **agent) -> Path:
    """Plug the scripted ACP agent in as engine "fake" and give it a team member, "coder"."""
    scenario_path, log_path = tmp_path / "scenario.json", tmp_path / "agent-log.jsonl"
    scenario_path.write_text(json.dumps(scenario), encoding="utf-8")
    platform.settings.set(
        "engines.agents",
        {
            "fake": {
                "name": "Fake agent",
                "command": sys.executable,
                "args": [str(FAKE), str(scenario_path), str(log_path)],
            }
        },
    )
    platform.registry.save_custom(
        {
            "id": "coder",
            "name": "Coder",
            "description": "Writes code",
            "provider": "acp:fake",
            "instructions": "Write code.",
            "output_schema": OUTPUT_SCHEMA,
            **agent,
        },
        create=True,
    )
    return log_path


def agent_log(path: Path, event: str | None = None) -> list[dict]:
    lines = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
    return [entry for entry in lines if event is None or entry["event"] == event]


def workspace(platform) -> Path:
    path = platform.config.default_workspace
    path.mkdir(parents=True, exist_ok=True)
    return path


async def test_a_team_member_works_on_an_acp_agent_under_the_platforms_rules(platform, tmp_path, monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "AIza-not-for-agents")
    monkeypatch.setenv("OPENAI_API_KEY", "sk-not-for-agents")
    (workspace(platform) / "a.txt").write_text("line 1\nline 2\nline 3\n", encoding="utf-8")
    log = use_fake_agent(
        platform,
        tmp_path,
        {
            "turns": [
                [
                    {"think": "I should read a.txt first."},
                    {"plan": [{"content": "Read a.txt", "priority": "high", "status": "in_progress"}]},
                    {"say": "Reading the file."},
                    {
                        "tool": {
                            "toolCallId": "t1",
                            "title": "Read a.txt",
                            "kind": "read",
                            "locations": [{"path": "a.txt"}],
                        }
                    },
                    {"read": {"path": "a.txt", "line": 2, "limit": 1}},
                    {
                        "tool": {
                            "toolCallId": "t2",
                            "title": "Create b.txt",
                            "kind": "edit",
                            "content": [{"type": "diff", "path": "b.txt", "oldText": None, "newText": "hello\n"}],
                        },
                        "ask": True,
                        "write": {"path": "b.txt", "content": "hello\n"},
                    },
                    {"report": {"answer": "b.txt created", "count": 1}},
                ]
            ]
        },
    )
    run_id = await platform.manager.submit(task="Create b.txt", agent_id="coder")
    requested = await wait_event(platform, run_id, "approval.requested")
    assert requested["data"]["tool"] == "acp.fake.edit"
    assert requested["data"]["args"]["path"] == "b.txt" and requested["data"]["args"]["content"] == "hello\n"
    await platform.manager.approvals.decide(requested["data"]["approval_id"], True, None, "owner")
    run = await wait_for(platform, run_id)

    assert run["status"] == "completed", run["error"]
    assert run["output"] == {"answer": "b.txt created", "count": 1}
    assert run["provider"] == "acp:fake" and run["model"] == "Fake agent 0.1"
    assert (workspace(platform) / "b.txt").read_text(encoding="utf-8") == "hello\n"

    # The agent ran without any AI vendor's key, on the platform's file access, in the project folder.
    assert agent_log(log, "env")[0]["keys"] == []
    init = agent_log(log, "initialize")[0]["params"]
    assert init["protocolVersion"] == 1 and init["clientCapabilities"]["fs"] == {
        "readTextFile": True,
        "writeTextFile": True,
    }
    assert agent_log(log, "session_new")[0]["params"] == {"cwd": str(workspace(platform)), "mcpServers": []}
    assert agent_log(log, "read")[0]["answer"]["result"] == {"content": "line 2\n"}
    assert agent_log(log, "permission")[0]["answer"]["result"]["outcome"] == {
        "outcome": "selected",
        "optionId": "allow-once",
    }
    assert agent_log(log, "write")[0]["answer"]["result"] == {}
    prompt = agent_log(log, "prompt")[0]["text"]
    assert "Write code." in prompt and "## Your task\nCreate b.txt" in prompt and '"answer"' in prompt

    events = events_of(platform, run_id)
    types = [e["type"] for e in events]
    assert {"agent.message", "agent.reasoning", "agent.tool_call", "tool.permission", "tool.completed"} <= set(types)
    started = next(e for e in events if e["type"] == "runtime.note" and "auth_method" in e["data"])
    assert started["data"]["message"] == "Fake agent session started"
    assert started["data"]["api_keys_removed"] == ["GEMINI_API_KEY", "OPENAI_API_KEY"]
    messages = [e["data"]["text"] for e in events if e["type"] == "agent.message"]
    assert messages[0] == "Reading the file."  # chunks are shown as one message
    plans = [e["data"]["text"] for e in events if e["type"] == "agent.reasoning" and e["data"].get("kind") == "plan"]
    assert plans == ["Plan:\n- [in_progress] Read a.txt"]
    completed = {e["data"]["tool_call_id"]: e["data"]["tool"] for e in events if e["type"] == "tool.completed"}
    assert completed["t1"] == "acp.fake.read" and completed["t2"] == "acp.fake.edit"
    response = next(e for e in events if e["type"] == "model.response")
    assert response["data"]["provider"] == "acp:fake" and response["data"]["cost_usd"] == 0.0
    assert "AIza-not-for-agents" not in str(events)


async def test_what_the_platform_refuses_an_acp_agent(platform, tmp_path):
    outside = tmp_path / "outside.txt"
    log = use_fake_agent(
        platform,
        tmp_path,
        {
            "turns": [
                [
                    # Asks to edit a file outside the project: refused without bothering the owner.
                    {
                        "tool": {
                            "toolCallId": "t1",
                            "title": "Edit",
                            "kind": "edit",
                            "locations": [{"path": str(outside)}],
                        },
                        "ask": True,
                    },
                    # Writes a secret file without asking: refused.
                    {"write": {"path": ".env", "content": "KEY=1"}},
                    # Reads outside the project: refused.
                    {"read": {"path": str(outside)}},
                    # Writes a project file without asking: decided like an edit, so the owner is asked.
                    {"write": {"path": "c.txt", "content": "unasked"}},
                    {"report": {"answer": "tried"}},
                ]
            ]
        },
    )
    outside.write_text("private", encoding="utf-8")
    run_id = await platform.manager.submit(task="Try things", agent_id="coder")
    requested = await wait_event(platform, run_id, "approval.requested")
    assert requested["data"]["tool"] == "acp.fake.write_file" and requested["data"]["args"]["path"] == "c.txt"
    await platform.manager.approvals.decide(requested["data"]["approval_id"], False, "not now", "owner")
    run = await wait_for(platform, run_id)
    assert run["status"] == "completed", run["error"]

    permission = agent_log(log, "permission")[0]["answer"]["result"]["outcome"]
    assert permission == {"outcome": "selected", "optionId": "reject-once"}
    writes = [entry["answer"] for entry in agent_log(log, "write")]
    assert "protected" in writes[0]["error"]["message"]
    assert "did not approve" in writes[1]["error"]["message"]
    assert "outside the workspace" in agent_log(log, "read")[0]["answer"]["error"]["message"]
    assert not (workspace(platform) / ".env").exists() and not (workspace(platform) / "c.txt").exists()
    assert outside.read_text(encoding="utf-8") == "private"
    approvals = events_of(platform, run_id, "approval.requested")
    assert len(approvals) == 1  # only the project file reached the owner


async def test_approve_modes_apply_to_an_acp_agents_commands(platform, tmp_path):
    platform.settings.set("permissions.mode", "auto")

    def command(call_id: str, command: str | None) -> dict:
        raw = {"command": command} if command else {}
        return {"tool": {"toolCallId": call_id, "title": "Run", "kind": "execute", "rawInput": raw}, "ask": True}

    log = use_fake_agent(
        platform,
        tmp_path,
        {
            "turns": [
                [
                    command("t1", "python -m pytest -q"),
                    command("t2", "git push origin main"),
                    command("t3", None),
                    {"report": {"answer": "ran"}},
                ]
            ]
        },  # fmt: skip
    )
    run_id = await platform.manager.submit(task="Run the checks", agent_id="coder")
    push = await wait_event(platform, run_id, "approval.requested")
    assert push["data"]["tool"] == "acp.fake.execute" and push["data"]["args"]["command"] == "git push origin main"
    await platform.manager.approvals.decide(push["data"]["approval_id"], False, None, "owner")
    for _ in range(50):
        pending = [e for e in events_of(platform, run_id, "approval.requested") if e["data"]["tool_call_id"] == "t3"]
        if pending:
            break
        await asyncio.sleep(0.05)
    assert pending, "a command the agent did not name still asks in auto mode"
    await platform.manager.approvals.decide(pending[0]["data"]["approval_id"], True, None, "owner")
    run = await wait_for(platform, run_id)
    assert run["status"] == "completed", run["error"]
    outcomes = [entry["answer"]["result"]["outcome"]["optionId"] for entry in agent_log(log, "permission")]
    assert outcomes == ["allow-once", "reject-once", "allow-once"]
    decided = {e["data"]["tool_call_id"]: e["data"]["rule"] for e in events_of(platform, run_id, "tool.permission")}
    assert decided["t1"].startswith("auto-approve")


async def test_an_acp_agent_that_forgets_its_report_is_asked_again(platform, tmp_path):
    log = use_fake_agent(
        platform,
        tmp_path,
        {"turns": [[{"say": "All done!"}], [{"report": {"answer": "here it is"}}]]},
    )
    run_id = await platform.manager.submit(task="Do it", agent_id="coder")
    run = await wait_for(platform, run_id)
    assert run["status"] == "completed", run["error"]
    assert run["output"] == {"answer": "here it is"}
    prompts = agent_log(log, "prompt")
    assert len(prompts) == 2 and "without a valid report" in prompts[1]["text"]


async def test_an_acp_agent_stops_at_its_step_limit(platform, tmp_path):
    def read(call_id: str) -> dict:
        return {"tool": {"toolCallId": call_id, "title": "Look", "kind": "search"}}

    use_fake_agent(
        platform,
        tmp_path,
        {"turns": [[read("t1"), read("t2"), read("t3"), {"report": {"answer": "x"}}]]},
        limits={"max_steps": 2},
    )
    run_id = await platform.manager.submit(task="Look around", agent_id="coder")
    run = await wait_for(platform, run_id)
    assert run["status"] == "failed" and "max_steps" in run["error"]


async def test_a_signed_out_or_missing_agent_says_what_to_do(platform, tmp_path):
    use_fake_agent(platform, tmp_path, {"auth_required": True, "turns": []})
    run_id = await platform.manager.submit(task="Anything", agent_id="coder")
    run = await wait_for(platform, run_id)
    assert run["status"] == "failed" and "Fake agent is not signed in" in run["error"]
    failed = events_of(platform, run_id, "run.failed")[0]
    assert failed["data"]["code"] == "not_signed_in"

    platform.registry.update_overrides("coder", {"provider": "acp:gemini"})
    if platform.providers.engines.get("gemini").executable() is None:  # not installed here: say how to install it
        with pytest.raises(SubmitError, match="not installed.*npm install -g @google/gemini-cli"):
            await platform.manager.submit(task="Anything", agent_id="coder")
    with pytest.raises(ProviderNotConfigured, match="not an agent this platform knows"):
        platform.providers.resolve("acp:nobody")


async def test_the_coordinator_stays_on_claude_code(platform, tmp_path):
    use_fake_agent(platform, tmp_path, {"turns": []}, id="planner", tools=["agent_delegate"], delegates=["helper"])
    run_id = await platform.manager.submit(task="Plan it", agent_id="planner")
    run = await wait_for(platform, run_id)
    assert run["status"] == "failed" and "only Claude Code can use today" in run["error"]


async def test_the_agent_catalog_and_its_setting(platform):
    ids = [engine.id for engine in CATALOG]
    assert {"gemini", "codex", "copilot", "cursor", "goose", "opencode", "qwen"} <= set(ids)
    status = platform.providers.engines_status()
    assert status[0]["provider"] == "claude-code" and status[0]["builtin"] is True
    gemini = next(item for item in status if item["id"] == "gemini")
    assert gemini["provider"] == "acp:gemini" and gemini["command"] == "gemini --acp" and gemini["install"]

    platform.settings.set(
        "engines.agents", {"gemini": {"command": "npx", "args": ["-y", "@google/gemini-cli", "--acp"]}}
    )
    changed = platform.providers.engines.get("gemini")
    assert changed.command_line() == "npx -y @google/gemini-cli --acp" and changed.name == "Gemini CLI"
    assert not changed.custom

    assert engines_problem({"mine": {"name": "Mine"}}) == "'mine' needs the command that starts it"
    assert "unknown fields: env" in engines_problem({"mine": {"command": "mine", "env": {"OPENAI_API_KEY": "x"}}})
    assert "valid id" in engines_problem({"Bad Id": {"command": "x"}})
    assert engines_problem({"mine": {"command": "mine-acp", "args": ["--acp"]}}) is None


def test_agents_never_get_an_api_key():
    env, removed = agent_environment(
        {"PATH": "x", "OPENAI_API_KEY": "1", "GEMINI_API_KEY": "2", "ANTHROPIC_AUTH_TOKEN": "3", "GH_TOKEN": "4"}
    )
    assert env == {"PATH": "x", "GH_TOKEN": "4"}  # a GitHub sign-in token is not an AI vendor's API key
    assert removed == ["ANTHROPIC_AUTH_TOKEN", "GEMINI_API_KEY", "OPENAI_API_KEY"]
    assert is_allowed_provider("acp:gemini") and is_allowed_provider("claude-code")
    assert not is_allowed_provider("openai") and not is_allowed_provider(None)


async def test_the_engines_route_and_choosing_an_agent(platform, config):
    from test_api import owner

    app = create_app(config, platform=platform)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://testserver") as client:
        csrf = await owner(client)
        items = (await client.get("/api/engines")).json()["items"]
        assert items[0]["id"] == "claude-code" and any(item["provider"] == "acp:codex" for item in items)
        refused = await client.patch("/api/settings", headers=csrf, json={"engines.agents": {"x": {"name": "X"}}})
        assert refused.status_code == 400
        saved = await client.patch(
            "/api/settings",
            headers=csrf,
            json={"engines.agents": {"mine": {"name": "Mine", "command": sys.executable}}},
        )
        assert saved.status_code == 200
        chosen = await client.patch("/api/agents/helper", headers=csrf, json={"overrides": {"provider": "acp:mine"}})
        assert chosen.status_code == 200, chosen.text
        assert chosen.json()["agent"]["provider"] == "acp:mine"
        wrong = await client.patch("/api/agents/helper", headers=csrf, json={"overrides": {"provider": "openai"}})
        assert wrong.status_code in (400, 422)
