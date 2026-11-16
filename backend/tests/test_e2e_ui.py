"""Browser end-to-end: the advanced paths of the web interface, against a real server and runtime.

Covers owner setup, the team directory, following a task live, approving inline, the result,
My Work, cancellation from the technical details page, the approvals center, and a team task on the
technical details page. Tasks are started through the API (the scripted test double); everyday
journeys, started from Home, are in test_e2e_journeys.py. Skipped when the frontend is not built or Chromium
is not installed for Playwright.
"""

from __future__ import annotations

import asyncio
import dataclasses
import socket

import pytest
import uvicorn

from pae.app import create_app
from pae.config import REPO_ROOT
from pae.db import Approval

from conftest import TEST_SETUP_TOKEN, final, wait_for

pytestmark = pytest.mark.anyio
DIST = REPO_ROOT / "frontend" / "dist"
PASSWORD = "an-e2e-owner-password"


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


@pytest.fixture
async def server(platform, config):
    if not (DIST / "index.html").is_file():
        pytest.skip("frontend not built (npm run build)")
    port = _free_port()
    app = create_app(dataclasses.replace(config, frontend_dist=DIST), platform=platform)
    instance = uvicorn.Server(
        uvicorn.Config(
            app, host="127.0.0.1", port=port, lifespan="off", log_level="warning", timeout_graceful_shutdown=2
        )
    )
    # On Windows, the proactor event loop reports a ConnectionResetError when the browser drops a
    # keep-alive or event-stream socket during shutdown. It is harmless; ignore only that case.
    loop = asyncio.get_running_loop()
    previous = loop.get_exception_handler()

    def handler(event_loop, context):
        if isinstance(context.get("exception"), ConnectionResetError | ConnectionAbortedError):
            return
        if previous is not None:
            previous(event_loop, context)
        else:
            event_loop.default_exception_handler(context)

    loop.set_exception_handler(handler)
    task = asyncio.create_task(instance.serve())
    while not instance.started:
        await asyncio.sleep(0.05)
    try:
        yield f"http://127.0.0.1:{port}"
    finally:
        instance.should_exit = True
        await task
        loop.set_exception_handler(previous)


@pytest.fixture
async def page(server):
    from playwright.async_api import Error, async_playwright

    async with async_playwright() as playwright:
        try:
            browser = await playwright.chromium.launch()
        except Error as exc:
            pytest.skip(f"Chromium for Playwright is not available: {exc}")
        context = await browser.new_context(viewport={"width": 1400, "height": 900})
        page = await context.new_page()
        page.set_default_timeout(15_000)
        errors: list[str] = []
        page.on("pageerror", lambda exc: errors.append(str(exc)))
        page.on("console", lambda msg: errors.append(msg.text) if msg.type == "error" else None)
        page.errors = errors
        yield page
        await page.goto("about:blank")  # close event streams before the browser goes away
        await browser.close()


async def submit_scripted(platform, *, agent: str, task: str, script: list) -> str:
    """Start one team member on a task with the scripted test double (no AI model)."""
    return await platform.manager.submit(
        task=task, agent_id=agent, provider="scripted", options={"provider_options": {"script": script}}
    )


async def test_ui_end_to_end(page, server, platform):
    from playwright.async_api import expect

    base = server
    # 1. First start: create the owner with the one-time setup token.
    await page.goto(base)
    await expect(page.get_by_role("heading", name="Create the owner account")).to_be_visible()
    await page.locator("#setup-username").fill("owner")
    await page.locator("#setup-password").fill(PASSWORD)
    await page.locator("#setup-confirm").fill(PASSWORD)
    await page.locator("#setup-token").fill(TEST_SETUP_TOKEN)
    await page.get_by_role("button", name="Create owner account").click()
    await expect(page.get_by_label("What would you like to accomplish?")).to_be_visible()

    # 2. The directory shows the real agents from agents/*.toml.
    await page.goto(f"{base}/team")
    for name in ("Researcher", "Coordinator", "Document Specialist"):
        await expect(page.get_by_text(name, exact=True).first).to_be_visible()

    # 3. A task (started through the API); the write waits for approval, shown live, approved inline.
    run_id = await submit_scripted(
        platform,
        agent="tester",
        task="e2e: write a report file",
        script=[
            {
                "text": "Writing the report.",
                "tool_calls": [{"name": "fs_write", "input": {"path": "e2e.txt", "content": "from the UI"}}],
            },
            final("ui-e2e-done"),
        ],
    )
    await page.goto(f"{base}/workspace/{run_id}")
    card = page.get_by_role("article", name="Approval request: Create a file").first
    await expect(card).to_be_visible()
    await expect(page.get_by_text("Test run, no AI model").first).to_be_visible()
    await expect(page.get_by_text("Writing the report.").first).to_be_visible()
    assert not (platform.config.default_workspace / "e2e.txt").exists()
    await card.get_by_role("button", name="Approve").click()
    await expect(page.get_by_text("Final result", exact=True)).to_be_visible()
    await expect(page.get_by_text("ui-e2e-done").first).to_be_visible()
    run = await wait_for(platform, run_id)
    assert run["status"] == "completed" and run["output"] == {"answer": "ui-e2e-done"}
    assert (platform.config.default_workspace / "e2e.txt").read_text() == "from the UI"

    # 4. My Work lists and searches it.
    await page.goto(f"{base}/work")
    await expect(page.get_by_text("e2e: write a report file").first).to_be_visible()

    # 5. Cancellation from the technical details page (the advanced view keeps its own controls).
    slow_id = await submit_scripted(platform, agent="tester", task="e2e: slow run", script=[{"delay_s": 30}])
    await wait_for(platform, slow_id, statuses=("running",))
    await page.goto(f"{base}/runs/{slow_id}")
    await page.get_by_role("button", name="Cancel", exact=True).click()
    await page.get_by_role("button", name="Cancel run").click()
    await expect(page.get_by_text("Cancelled").first).to_be_visible()
    assert (await wait_for(platform, slow_id))["status"] == "cancelled"

    # 6. Approvals center: reject a pending request raised outside the UI.
    pending_id = await platform.manager.submit(
        task="e2e: delete something",
        agent_id="tester",
        options={
            "provider_options": {
                "script": [{"tool_calls": [{"name": "fs_delete", "input": {"path": "e2e.txt"}}]}, final("not deleted")]
            }
        },
    )
    await page.goto(f"{base}/approvals")
    pending = page.get_by_role("article", name="Approval request: Delete a file")
    await expect(pending).to_be_visible()
    await pending.get_by_role("button", name="Reject").click()
    assert (await wait_for(platform, pending_id))["status"] == "completed"
    with platform.db.session() as session:
        assert session.query(Approval).filter_by(run_id=pending_id).one().status == "rejected"
    assert (platform.config.default_workspace / "e2e.txt").exists()

    # 7. A team run shows its tree and members.
    team_id = await platform.manager.submit(
        task="e2e team",
        provider="scripted",
        team={"mode": "sequential", "members": [{"agent": "helper"}, {"agent": "tester"}]},
        options={"tree": {"scripts": {"helper": [{"text": "helper part"}], "tester": [final("team done")]}}},
    )
    await wait_for(platform, team_id)
    await page.goto(f"{base}/runs/{team_id}")
    tree = page.get_by_role("list", name="Runs in this tree")
    await expect(tree.get_by_role("listitem")).to_have_count(3)
    await expect(page.get_by_text("team done").first).to_be_visible()

    assert not [e for e in page.errors if "401" not in e], page.errors
