"""MCP: the client hub exposes a real stdio server's tools behind the gate, and the
platform's own MCP bridge serves agents to other MCP clients."""

from __future__ import annotations

import asyncio
import json
import os
import socket
import sys
from pathlib import Path

import pytest
import uvicorn

from pae.app import create_app

from conftest import TEST_SETUP_TOKEN, final, wait_event, wait_for

pytestmark = pytest.mark.anyio
FIXTURE = Path(__file__).parent / "fixtures" / "echo_mcp_server.py"


async def test_mcp_tools_are_registered_and_gated(platform):
    platform.settings.set(
        "mcp.servers",
        [{"name": "echo", "command": sys.executable, "args": [str(FIXTURE)], "enabled": True, "permission": "ask"}],
    )
    await platform.mcp.restart()
    status = platform.mcp.status()[0]
    assert status["status"] == "connected", status
    assert set(status["tools"]) == {"mcp__echo__echo", "mcp__echo__add"}
    assert platform.tools.get("mcp__echo__add").untrusted_output

    platform.registry.update_overrides("tester", {"tools": ["mcp__echo__add", "mcp__echo__echo"]})
    run_id = await platform.manager.submit(
        task="add",
        agent_id="tester",
        options={
            "provider_options": {
                "script": [
                    {"tool_calls": [{"name": "mcp__echo__add", "input": {"a": 2, "b": 40}}]},
                    {"tool_calls": [{"name": "mcp__echo__add", "input": {"a": "x"}}]},
                    final("42"),
                ]
            }
        },
    )
    requested = await wait_event(platform, run_id, "approval.requested")  # external tools default to ask
    await platform.manager.approvals.decide(requested["data"]["approval_id"], True, None, "owner")
    for _ in range(200):
        pending = [e for e in platform.manager.bus.history(root_run_id=run_id) if e["type"] == "approval.requested"]
        if len(pending) == 2:
            await platform.manager.approvals.decide(pending[1]["data"]["approval_id"], True, None, "owner")
            break
        await asyncio.sleep(0.02)
    run = await wait_for(platform, run_id)
    assert run["status"] == "completed"
    events = platform.manager.bus.history(root_run_id=run_id)
    completed = [e for e in events if e["type"] == "tool.completed"]
    failed = [e for e in events if e["type"] == "tool.failed"]
    assert "42" in completed[0]["data"]["output"]
    assert "invalid arguments" in failed[0]["data"]["error"]
    await platform.mcp.stop()
    assert platform.tools.get("mcp__echo__add") is None


async def test_failing_mcp_server_reports_error(platform):
    platform.settings.set(
        "mcp.servers", [{"name": "broken", "command": "definitely-not-a-command-xyz", "args": [], "enabled": True}]
    )
    await platform.mcp.restart()
    status = platform.mcp.status()[0]
    assert status["status"] == "error" and status["error"]


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


async def test_platform_mcp_bridge_serves_agents(platform, config):
    from mcp import ClientSession
    from mcp.client.stdio import StdioServerParameters, stdio_client

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
        while not server.started:
            await asyncio.sleep(0.05)
        import httpx

        async with httpx.AsyncClient(base_url=f"http://127.0.0.1:{port}") as client:
            setup = await client.post(
                "/api/auth/setup",
                json={"username": "owner", "password": "a-long-password", "setup_token": TEST_SETUP_TOKEN},
            )
            csrf = {"x-csrf-token": setup.json()["csrf_token"]}
            token = (await client.post("/api/tokens", headers=csrf, json={"name": "mcp"})).json()["token"]
        params = StdioServerParameters(
            command=sys.executable,
            args=["-m", "pae.cli", "mcp-serve", "--url", f"http://127.0.0.1:{port}"],
            env={**os.environ, "PAE_API_TOKEN": token},
        )
        async with stdio_client(params) as (read, write), ClientSession(read, write) as session:
            await session.initialize()
            names = {t.name for t in (await session.list_tools()).tools}
            assert {"list_agents", "run_agent", "get_run"} <= names
            listed = await session.call_tool("list_agents", {})
            agents = json.loads(listed.content[0].text)
            assert any(a["id"] == "research" for a in agents)
            # run_agent goes through the API; the scripted tester agent finishes immediately.
            platform.registry.update_overrides("tester", {"tools": []})
            result = await session.call_tool("run_agent", {"agent_id": "helper", "task": "say hello", "wait_s": 20})
            payload = json.loads(result.content[0].text)
            assert payload["status"] == "completed", payload
    finally:
        server.should_exit = True
        await serving
