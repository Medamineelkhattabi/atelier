"""Hardening: security headers, static file boundary, concurrency stress, retention."""

from __future__ import annotations

import asyncio
import dataclasses
from datetime import timedelta

import httpx
import pytest

from pae.app import create_app
from pae.db import Run, RunEvent, utcnow

from conftest import final, wait_for

pytestmark = pytest.mark.anyio


@pytest.fixture
async def spa_client(platform, config, tmp_path):
    dist = tmp_path / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text("<html>app</html>")
    (dist / "assets" / "app.js").write_text("console.log(1)")
    (tmp_path / "outside.txt").write_text("must not be served")
    app = create_app(dataclasses.replace(config, frontend_dist=dist), platform=platform)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://testserver") as client:
        yield client


async def test_security_headers_and_no_store(spa_client):
    response = await spa_client.get("/api/health")
    assert response.headers["x-frame-options"] == "DENY"
    assert response.headers["x-content-type-options"] == "nosniff"
    assert "default-src 'self'" in response.headers["content-security-policy"]
    assert response.headers["cache-control"] == "no-store"


async def test_spa_fallback_and_static_boundary(spa_client):
    assert (await spa_client.get("/runs/abc")).text == "<html>app</html>"
    assert (await spa_client.get("/assets/app.js")).text == "console.log(1)"
    for path in ("/..%2Foutside.txt", "/%2e%2e/outside.txt", "/assets/..%2F..%2Foutside.txt"):
        assert "must not be served" not in (await spa_client.get(path)).text, path
    assert (await spa_client.get("/api/unknown")).status_code == 404


async def test_stress_many_concurrent_runs(platform):
    platform.settings.set("limits.max_concurrent_runs", 8)
    script = [{"delay_s": 0.05, "tool_calls": [{"name": "fs_list", "input": {}}]}, final("ok")]
    ids = await asyncio.gather(
        *(
            platform.manager.submit(
                task=f"stress {i}", agent_id="tester", options={"provider_options": {"script": script}}
            )
            for i in range(40)
        )
    )
    results = await asyncio.gather(*(wait_for(platform, run_id, timeout=60) for run_id in ids))
    assert [r["status"] for r in results] == ["completed"] * 40
    # The concurrency limit holds: at no instant were more than 8 runs executing.
    edges = sorted([(r["started_at"], 1) for r in results] + [(r["finished_at"], -1) for r in results])
    running = peak = 0
    for _, delta in edges:
        running += delta
        peak = max(peak, running)
    assert 1 < peak <= 8, peak
    with platform.db.session() as session:
        assert session.query(RunEvent).filter(RunEvent.root_run_id.in_(ids)).count() >= 40 * 10


async def test_retention_purges_only_old_finished_trees(platform):
    old = await platform.manager.submit(
        task="old", agent_id="tester", options={"provider_options": {"script": [final()]}}
    )
    recent = await platform.manager.submit(
        task="recent", agent_id="tester", options={"provider_options": {"script": [final()]}}
    )
    await wait_for(platform, old)
    await wait_for(platform, recent)
    platform.manager.update_run(old, created_at=utcnow() - timedelta(days=200))
    assert platform.purge_expired(90) == 1
    with platform.db.session() as session:
        assert session.get(Run, old) is None and session.get(Run, recent) is not None
        assert session.query(RunEvent).filter(RunEvent.root_run_id == old).count() == 0
