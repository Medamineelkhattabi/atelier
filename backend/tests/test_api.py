"""HTTP API: auth, CSRF, runs, live SSE over a real server, approvals, agents, settings, secrets, tokens."""

from __future__ import annotations

import asyncio
import json
import socket

import httpx
import pytest
import uvicorn

from pae.app import create_app

from conftest import TEST_SETUP_TOKEN, call, final, wait_for

pytestmark = pytest.mark.anyio
PASSWORD = "a-long-test-password"


@pytest.fixture
async def client(platform, config):
    app = create_app(config, platform=platform)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://testserver") as c:
        yield c


async def owner(client) -> dict:
    """Create the owner and return the CSRF header for subsequent writes."""
    response = await client.post(
        "/api/auth/setup", json={"username": "owner", "password": PASSWORD, "setup_token": TEST_SETUP_TOKEN}
    )
    assert response.status_code == 200, response.text
    return {"x-csrf-token": response.json()["csrf_token"]}


async def test_health_is_public_but_everything_else_needs_auth(client):
    assert (await client.get("/api/health")).json()["status"] == "ok"
    for path in ("/api/agents", "/api/runs", "/api/dashboard", "/api/settings", "/api/secrets"):
        assert (await client.get(path)).status_code == 401, path


async def test_setup_requires_token_and_happens_once(client):
    bad = await client.post("/api/auth/setup", json={"username": "owner", "password": PASSWORD, "setup_token": "wrong"})
    assert bad.status_code == 403
    await owner(client)
    again = await client.post(
        "/api/auth/setup", json={"username": "second", "password": PASSWORD, "setup_token": TEST_SETUP_TOKEN}
    )
    assert again.status_code == 409


async def test_csrf_is_enforced_for_cookie_sessions(client):
    csrf = await owner(client)
    no_csrf = await client.post("/api/runs", json={"task": "x", "agent_id": "tester"})
    assert no_csrf.status_code == 403
    ok = await client.post(
        "/api/runs",
        headers=csrf,
        json={"task": "x", "agent_id": "tester", "options": {"provider_options": {"script": [final()]}}},
    )
    assert ok.status_code == 200


async def test_login_rate_limit_and_logout(client):
    await owner(client)
    client.cookies.clear()
    for _ in range(5):
        assert (
            await client.post("/api/auth/login", json={"username": "owner", "password": "wrong-password-1"})
        ).status_code == 401
    assert (await client.post("/api/auth/login", json={"username": "owner", "password": PASSWORD})).status_code == 429


async def test_run_lifecycle_history_and_detail(client, platform):
    csrf = await owner(client)
    (platform.config.default_workspace).mkdir(parents=True, exist_ok=True)
    (platform.config.default_workspace / "f.txt").write_text("content")
    created = await client.post(
        "/api/runs",
        headers=csrf,
        json={
            "task": "read the file named f.txt",
            "agent_id": "tester",
            "options": {"provider_options": {"script": [call("fs_read", path="f.txt"), final("read it")]}},
        },
    )
    run_id = created.json()["run_id"]
    await wait_for(platform, run_id)
    detail = (await client.get(f"/api/runs/{run_id}")).json()
    assert detail["run"]["status"] == "completed" and detail["run"]["output"] == {"answer": "read it"}
    assert detail["run"]["scripted"] is True and detail["tree_totals"]["runs"] == 1
    events = (await client.get(f"/api/runs/{run_id}/events")).json()["events"]
    assert any(e["type"] == "tool.completed" for e in events)
    listing = (await client.get("/api/runs", params={"q": "f.txt"})).json()
    assert listing["total"] == 1 and listing["items"][0]["id"] == run_id
    assert (await client.get("/api/runs", params={"status": "failed"})).json()["total"] == 0
    dashboard = (await client.get("/api/dashboard")).json()
    assert dashboard["window"]["completed"] == 1 and dashboard["agents"]["total"] >= 12
    deleted = await client.delete(f"/api/runs/{run_id}", headers=csrf)
    assert deleted.status_code == 200 and (await client.get(f"/api/runs/{run_id}")).status_code == 404


async def test_approval_and_cancel_through_api(client, platform):
    csrf = await owner(client)
    created = await client.post(
        "/api/runs",
        headers=csrf,
        json={
            "task": "write a file",
            "agent_id": "tester",
            "options": {"provider_options": {"script": [call("fs_write", path="w.txt", content="w"), final()]}},
        },
    )
    run_id = created.json()["run_id"]
    await wait_for(platform, run_id, statuses=("waiting_approval",))
    pending = (await client.get("/api/approvals")).json()["items"]
    assert len(pending) == 1 and pending[0]["tool"] == "fs_write" and pending[0]["run_task"] == "write a file"
    decision = await client.post(
        f"/api/approvals/{pending[0]['id']}/decision", headers=csrf, json={"approve": True, "note": "fine"}
    )
    assert decision.json()["status"] == "approved"
    assert (
        await client.post(f"/api/approvals/{pending[0]['id']}/decision", headers=csrf, json={"approve": False})
    ).status_code == 409
    await wait_for(platform, run_id)

    slow = await client.post(
        "/api/runs",
        headers=csrf,
        json={"task": "slow", "agent_id": "tester", "options": {"provider_options": {"script": [{"delay_s": 10}]}}},
    )
    slow_id = slow.json()["run_id"]
    await wait_for(platform, slow_id, statuses=("running",))
    assert (await client.post(f"/api/runs/{slow_id}/cancel", headers=csrf)).json()["status"] == "cancelling"
    assert (await wait_for(platform, slow_id))["status"] == "cancelled"
    assert (await client.post(f"/api/runs/{slow_id}/cancel", headers=csrf)).status_code == 400


async def test_agents_api(client):
    csrf = await owner(client)
    agents = (await client.get("/api/agents")).json()
    ids = {a["id"] for a in agents["items"]}
    expected = {
        "research",
        "planning",
        "software-engineering",
        "code-review",
        "debugging",
        "testing",
        "documentation",
        "automation",
        "data",
        "document-processing",
        "orchestrator",
        "evaluator",
    }
    assert expected <= ids and not agents["load_errors"]
    for agent in agents["items"]:
        if agent["id"] in expected:
            assert agent["status"] == "ready", (agent["id"], agent["problems"])
    detail = (await client.get("/api/agents/research")).json()
    assert "output_schema" in detail["toml"] and detail["agent"]["tools_detail"]
    patched = await client.patch(
        "/api/agents/research", headers=csrf, json={"enabled": False, "overrides": {"effort": "low"}}
    )
    assert patched.json()["agent"]["enabled"] is False and patched.json()["agent"]["effort"] == "low"
    bad = await client.patch("/api/agents/research", headers=csrf, json={"overrides": {"name": "x"}})
    assert bad.status_code == 400
    reset = await client.post("/api/agents/research/reset", headers=csrf)
    assert reset.json()["agent"]["effort"] == "high"
    new = {"id": "my-agent", "name": "Mine", "description": "custom", "instructions": "do", "tools": ["fs_read"]}
    assert (await client.post("/api/agents", headers=csrf, json=new)).status_code == 200
    assert (await client.post("/api/agents", headers=csrf, json=new)).status_code == 400
    assert (await client.delete("/api/agents/research", headers=csrf)).status_code == 400
    assert (await client.delete("/api/agents/my-agent", headers=csrf)).status_code == 200
    teams = (await client.get("/api/teams")).json()["items"]
    assert {"research-to-plan", "quality-gate", "delivery"} <= {t["id"] for t in teams}


async def test_secrets_are_write_only(client):
    csrf = await owner(client)
    put = await client.put("/api/secrets/SERVICE_TOKEN", headers=csrf, json={"value": "svc-secretvalue9999"})
    assert put.json() == {"name": "SERVICE_TOKEN", "hint": "...9999", "project_id": None}
    listed = (await client.get("/api/secrets")).text
    assert "secretvalue" not in listed and "...9999" in listed
    # Claude credentials and API keys are never stored by the platform.
    for name in ("ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "OPENAI_API_KEY"):
        refused = await client.put(f"/api/secrets/{name}", headers=csrf, json={"value": "x" * 20})
        assert refused.status_code == 400 and "subscription" in refused.json()["detail"], name
    providers = (await client.get("/api/providers")).json()["items"]
    assert [p["name"] for p in providers] == ["claude-code", "scripted"]
    assert providers[0]["policy"] == "subscription-only"
    assert (await client.put("/api/secrets/bad name", headers=csrf, json={"value": "x"})).status_code in (400, 404)
    assert "secretvalue" not in (await client.get("/api/audit")).text


async def test_settings_validation(client):
    csrf = await owner(client)
    ok = await client.patch("/api/settings", headers=csrf, json={"limits.max_steps": 12})
    assert ok.json()["values"]["limits.max_steps"] == 12
    for body in (
        {"unknown.key": 1},
        {"limits.max_steps": "many"},
        {"providers.default": "nope"},
        {"providers.default": "anthropic"},
        {"shell.sandbox": "vm"},
        {"workspaces.roots": ["Z:/does/not/exist"]},
    ):
        assert (await client.patch("/api/settings", headers=csrf, json=body)).status_code == 400, body


async def test_api_tokens_for_automation(client, platform):
    csrf = await owner(client)
    token = (await client.post("/api/tokens", headers=csrf, json={"name": "ci"})).json()["token"]
    client.cookies.clear()
    bearer = {"authorization": f"Bearer {token}"}
    assert (await client.get("/api/agents", headers=bearer)).status_code == 200
    created = await client.post(
        "/api/runs",
        headers=bearer,
        json={"task": "from automation", "agent_id": "tester", "options": {"provider_options": {"script": [final()]}}},
    )
    assert created.status_code == 200  # bearer clients need no CSRF header
    assert (await client.get("/api/agents", headers={"authorization": "Bearer nope"})).status_code == 401
    assert (await client.post("/api/tokens", headers=bearer, json={"name": "escalate"})).status_code == 403


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


async def test_sse_streams_live_events_over_a_real_server(platform, config):
    port = _free_port()
    server = uvicorn.Server(
        uvicorn.Config(
            create_app(config, platform=platform),
            host="127.0.0.1",
            port=port,
            lifespan="off",
            log_level="warning",
            timeout_graceful_shutdown=2,
        )
    )
    serving = asyncio.create_task(server.serve())
    try:
        for _ in range(100):
            if server.started:
                break
            await asyncio.sleep(0.05)
        base = f"http://127.0.0.1:{port}"
        async with httpx.AsyncClient(base_url=base, timeout=20) as client:
            csrf = await owner(client)
            run_id = (
                await client.post(
                    "/api/runs",
                    headers=csrf,
                    json={
                        "task": "stream me",
                        "agent_id": "tester",
                        "options": {
                            "provider_options": {
                                "script": [{"delay_s": 0.3, **call("fs_list")}, {"delay_s": 0.3, **final("streamed")}]
                            }
                        },
                    },
                )
            ).json()["run_id"]
            seen, ids = [], []
            async with client.stream("GET", f"/api/runs/{run_id}/stream") as stream:
                assert stream.headers["content-type"].startswith("text/event-stream")
                async for line in stream.aiter_lines():
                    if line.startswith("data: "):
                        event = json.loads(line[6:])
                        seen.append(event["type"])
                        ids.append(event["id"])
                        if event["type"] == "run.completed":
                            break
            assert seen[0] == "run.queued" and "tool.completed" in seen and seen[-1] == "run.completed"
            assert ids == sorted(ids)
            # Reconnect with Last-Event-ID: only newer events are replayed (none here).
            async with client.stream(
                "GET", f"/api/runs/{run_id}/stream", headers={"last-event-id": str(ids[-1])}
            ) as stream:
                async for line in stream.aiter_lines():
                    assert not line.startswith("data: "), "no event is replayed twice"
                    if line.startswith(": connected"):
                        break
    finally:
        server.should_exit = True
        await serving


async def test_eval_suite_runs_through_the_api(client):
    csrf = await owner(client)
    suites = (await client.get("/api/evals")).json()["items"]
    assert {"runtime-contracts", "agents-live"} <= {s["id"] for s in suites}
    started = await client.post("/api/evals/runtime-contracts/run", headers=csrf, json={})
    eval_id = started.json()["eval_run_id"]
    for _ in range(300):
        detail = (await client.get(f"/api/eval-runs/{eval_id}")).json()
        if detail["status"] != "running":
            break
        await asyncio.sleep(0.05)
    assert detail["status"] == "completed", detail
    assert detail["summary"]["pass_rate"] == 1.0 and len(detail["results"]) == detail["summary"]["cases"]
    latest = next(s for s in (await client.get("/api/evals")).json()["items"] if s["id"] == "runtime-contracts")
    assert latest["latest"]["id"] == eval_id


async def test_project_bootstrap_endpoint(client, platform):
    csrf = await owner(client)
    capabilities = (await client.get("/api/projects/capabilities")).json()["items"]
    assert {"base", "claude", "hooks", "python"} <= {c["name"] for c in capabilities}
    root = platform.config.workspace_roots[0]
    created = await client.post(
        "/api/projects/bootstrap",
        headers=csrf,
        json={"directory": str(root / "new-app"), "capabilities": ["python", "hooks"]},
    )
    assert created.status_code == 200 and ".claude/hooks/guard.py" in created.json()["files"]
    outside = await client.post(
        "/api/projects/bootstrap",
        headers=csrf,
        json={"directory": str(root.parent.parent / "elsewhere"), "capabilities": ["base"]},
    )
    assert outside.status_code == 400 and "workspace root" in outside.json()["detail"]
    again = await client.post(
        "/api/projects/bootstrap", headers=csrf, json={"directory": str(root / "new-app"), "capabilities": ["python"]}
    )
    assert again.status_code == 409
    conflicts = again.json()["detail"]["conflicts"]
    # "python" requires "base", so its files conflict too; the list is structured, not prose.
    assert {"pyproject.toml", "src/new_app/__init__.py", "tests/test_smoke.py", "README.md"} <= set(conflicts)


async def test_adhoc_team_totals_timestamps_and_dashboard_counts(client, platform):
    csrf = await owner(client)
    scripts = {"helper": [{"error": {"message": "member broke", "retryable": False}}], "tester": [final("second ran")]}
    created = await client.post(
        "/api/runs",
        headers=csrf,
        json={
            "task": "adhoc team",
            "provider": "scripted",
            "team": {
                "mode": "sequential",
                "on_failure": "continue",
                "members": [{"agent": "helper"}, {"agent": "tester"}],
            },
            "options": {"tree": {"scripts": scripts}},
        },
    )
    assert created.status_code == 200, created.text
    run_id = created.json()["run_id"]
    run = await wait_for(platform, run_id)
    assert run["status"] == "completed", run["error"]  # on_failure=continue: the failing member did not stop the team
    item = (await client.get("/api/runs")).json()["items"][0]
    assert item["id"] == run_id and item["tree_totals"]["runs"] == 3 and item["tree_totals"]["steps"] >= 2
    assert item["created_at"].endswith("+00:00") and item["finished_at"].endswith("+00:00")
    events = (await client.get(f"/api/runs/{run_id}/events")).json()["events"]
    assert all(e["ts"].endswith("+00:00") for e in events)
    window = (await client.get("/api/dashboard")).json()["window"]
    assert window["runs"] == 1  # root runs only; the two member runs are not counted twice
    assert window["input_tokens"] > 0  # but their usage is
