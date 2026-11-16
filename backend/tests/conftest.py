from __future__ import annotations

import asyncio
import time
from pathlib import Path

import pytest

from pae.config import REPO_ROOT, Config
from pae.platform import Platform

TEST_SETUP_TOKEN = "test-setup-token"

OUTPUT_SCHEMA = {
    "type": "object",
    "required": ["answer"],
    "properties": {"answer": {"type": "string"}, "count": {"type": "integer"}},
    "additionalProperties": False,
}


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture
def config(tmp_path: Path) -> Config:
    data = tmp_path / "data"
    return Config(
        data_dir=data,
        database_url=f"sqlite:///{(data / 'pae.db').as_posix()}",
        host="127.0.0.1",
        port=0,
        agents_dir=REPO_ROOT / "agents",
        evals_dir=REPO_ROOT / "evals",
        templates_dir=REPO_ROOT / "templates",
        frontend_dist=tmp_path / "no-frontend",
        workspace_roots=(data / "workspaces",),
        default_workspace=data / "workspaces" / "default",
        cookie_secure=False,
        session_ttl_hours=1,
        setup_token=TEST_SETUP_TOKEN,
        claude_code_path=None,
        log_level="WARNING",
    )


def tester_agent(**overrides) -> dict:
    agent = {
        "id": "tester",
        "name": "Tester",
        "description": "Test agent",
        "provider": "scripted",
        "instructions": "Test agent.",
        "tools": [
            "fs_list",
            "fs_read",
            "fs_write",
            "fs_delete",
            "shell_run",
            "web_fetch",
            "agent_delegate",
            "agent_list",
            "data_query",
        ],
        "delegates": ["helper"],
        "output_schema": OUTPUT_SCHEMA,
    }
    agent.update(overrides)
    return agent


@pytest.fixture
async def platform(config):
    plat = Platform(config)
    plat.settings.set("providers.default", "scripted")
    # Tests that need them turn these on: no Windows notification and no automatic security review by default.
    plat.settings.set("notifications.windows", False)
    plat.settings.set("security.review_changes", False)
    plat.registry.save_custom(tester_agent(), create=True)
    plat.registry.save_custom(
        {
            "id": "helper",
            "name": "Helper",
            "description": "Helper agent",
            "provider": "scripted",
            "instructions": "Help.",
            "tools": ["fs_read"],
        },
        create=True,
    )
    await plat.start()
    try:
        yield plat
    finally:
        await plat.stop()


async def wait_for(
    platform, run_id: str, statuses=("completed", "failed", "cancelled", "interrupted"), timeout: float = 15.0
) -> dict:
    from pae.db import Run

    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        with platform.db.session() as session:
            run = session.get(Run, run_id)
            if run.status in statuses:
                return {c.name: getattr(run, c.name) for c in Run.__table__.columns}
        await asyncio.sleep(0.02)
    raise AssertionError(f"run {run_id} did not reach {statuses}; last status {run.status}")


async def wait_event(platform, run_id: str, event_type: str, timeout: float = 10.0) -> dict:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        for event in platform.manager.bus.history(root_run_id=run_id):
            if event["type"] == event_type:
                return event
        await asyncio.sleep(0.02)
    raise AssertionError(f"no {event_type} event for {run_id}")


def events_of(platform, run_id: str, event_type: str | None = None) -> list[dict]:
    events = platform.manager.bus.history(root_run_id=run_id)
    return [e for e in events if event_type is None or e["type"] == event_type]


def final(answer: str = "done", **extra) -> dict:
    return {"tool_calls": [{"name": "final_answer", "input": {"answer": answer, **extra}}]}


def call(name: str, **arguments) -> dict:
    return {"tool_calls": [{"name": name, "input": arguments}]}
