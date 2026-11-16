"""Exposes platform agents to any MCP client (e.g. Claude Code in another project).

Register in a project's .mcp.json:
  {"mcpServers": {"pae": {"command": "<repo>/backend/.venv/Scripts/pae", "args": ["mcp-serve"],
                          "env": {"PAE_API_TOKEN": "<token from Settings > API tokens>"}}}}

The bridge only calls the platform's HTTP API with that token, so every run
still goes through the platform's permissions, approvals, limits and history.
"""

from __future__ import annotations

import asyncio
import json
import os
import time

import httpx

TERMINAL = {"completed", "failed", "cancelled", "interrupted"}


def serve(url: str, token_env: str = "PAE_API_TOKEN") -> None:  # noqa: S107 - an env var name
    from mcp.server.mcpserver import MCPServer

    token = os.environ.get(token_env)
    if not token:
        raise SystemExit(f"set {token_env} to a platform API token")
    headers = {"authorization": f"Bearer {token}"}
    server = MCPServer(
        name="pae",
        instructions="Run Atelier's AI team members. Runs that need approval wait for the owner in the platform UI.",
    )

    async def api(method: str, path: str, **kwargs) -> dict:
        async with httpx.AsyncClient(base_url=url, headers=headers, timeout=60) as client:
            response = await client.request(method, path, **kwargs)
        if response.status_code >= 400:
            raise RuntimeError(f"platform API {response.status_code}: {response.text[:500]}")
        return response.json()

    @server.tool(description="List the platform's enabled agents with their capabilities and input hints.")
    async def list_agents() -> str:
        data = await api("GET", "/api/agents")
        agents = [
            {
                "id": a["id"],
                "name": a["name"],
                "description": a["description"],
                "capabilities": a["capabilities"],
                "input_hint": a["input_hint"],
                "status": a["status"],
            }
            for a in data["items"]
            if a["enabled"]
        ]
        return json.dumps(agents, indent=1)

    @server.tool(
        description="Run a platform agent on a task. `workspace` must be inside the platform's allowed "
        "workspace roots. Waits up to wait_s seconds, then returns the run status and output."
    )
    async def run_agent(agent_id: str, task: str, workspace: str | None = None, wait_s: int = 600) -> str:
        created = await api("POST", "/api/runs", json={"agent_id": agent_id, "task": task, "workspace": workspace})
        return await _wait(created["run_id"], wait_s)

    @server.tool(description="Get the status and output of a platform run.")
    async def get_run(run_id: str, wait_s: int = 0) -> str:
        return await _wait(run_id, wait_s)

    async def _wait(run_id: str, wait_s: int) -> str:
        deadline = time.monotonic() + max(0, wait_s)
        while True:
            run = (await api("GET", f"/api/runs/{run_id}"))["run"]
            if run["status"] in TERMINAL or time.monotonic() >= deadline:
                break
            await asyncio.sleep(2)
        return json.dumps(
            {
                "run_id": run_id,
                "status": run["status"],
                "output": run["output"],
                "output_text": run["output_text"],
                "error": run["error"],
                "ui": f"{url}/runs/{run_id}",
            },
            indent=1,
            default=str,
        )

    server.run("stdio")
