"""User journeys in a real browser, as a first-time, non-technical owner would take them.

Real server, real runtime, real built interface. Where a task would call the AI model, the test
adds a script to the request the page sends (the scripted provider is the labelled test double);
everything else -- team members, steps, hand-offs, approvals, events, project isolation -- is real.

Desktop: understand the home page, discover the team, create a project, start a task, check the
Coordinator's plan, follow it, inspect results, approve, use the detailed map, continue a finished task,
find past work, decide in Approvals, send a plan back with what should change, pause and stop.
Phone: navigate with the menu, start a task, follow it, approve, and no screen scrolls sideways.
Skipped when the frontend is not built or Chromium is not installed for Playwright.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest
from test_e2e_ui import page, server  # noqa: F401  (shared browser fixtures)

from conftest import TEST_SETUP_TOKEN, events_of, wait_event, wait_for

pytestmark = pytest.mark.anyio
PASSWORD = "an-e2e-owner-password"
NAV = ("Home", "Live Workspace", "My Work", "Approvals", "My AI Team", "My Projects", "Tools & Connections", "Settings")

# The deepest elements that stick out past the right edge of the viewport (for failure messages).
WIDEST = """
[...document.querySelectorAll('body *')]
  .filter((el) => el.getBoundingClientRect().right > window.innerWidth + 1)
  .filter((el) => ![...el.children].some((c) => c.getBoundingClientRect().right > window.innerWidth + 1))
  .slice(0, 5)
  .map((el) => `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 80)}`)
"""


def final_answer(**output) -> dict:
    return {"tool_calls": [{"name": "final_answer", "input": output}]}


RESEARCH = final_answer(
    status="complete",
    summary="Three hiring constraints found",
    findings=[{"claim": "Candidates are anonymised", "evidence": "project notes", "source_ids": ["s1"]}],
    sources=[{"id": "s1", "location": "project notes"}],
    open_questions=["What is the salary range?"],
    issues=[],
)


def team_scripts(file_name: str = "hiring-notes.md", research_delay: float = 0.0) -> dict:
    plan = [
        {
            "id": "research",
            "agent_id": "research",
            "title": "Collect hiring constraints",
            "task": "List the hiring constraints in the project notes.",
            "reason": "Needs sourced findings",
        },
        {
            "id": "docs",
            "agent_id": "documentation",
            "title": "Write the hiring notes",
            "task": f"Write {file_name} from the research findings.",
            "depends_on": ["research"],
            "reason": "Writes documents",
        },
    ]
    return {
        "orchestrator": [
            {
                "text": "Research first, then the notes.",
                "tool_calls": [{"name": "agent_run_plan", "input": {"tasks": plan}}],
            },
            final_answer(
                status="complete",
                summary="Hiring notes written from three constraints.",
                steps=[
                    {"task_id": "research", "agent": "research", "task": "constraints", "status": "completed"},
                    {"task_id": "docs", "agent": "documentation", "task": "notes", "status": "completed"},
                ],
                result=f"{file_name} now lists the three hiring constraints.\n\n"
                "| Constraint | Source |\n|---|---|\n| **Anonymised candidates** | project notes |",
                validation=[],
                issues=[],
            ),
        ],
        "research": [{"delay_s": research_delay, **RESEARCH}],
        "documentation": [
            {
                "text": "Writing the notes.",
                "tool_calls": [{"name": "fs_write", "input": {"path": file_name, "content": "# Hiring notes\n"}}],
            },
            final_answer(
                status="complete", summary=f"{file_name} written", files_written=[file_name], sources_read=[], issues=[]
            ),
        ],
    }


FOLLOW_UP = final_answer(
    status="complete",
    summary="Salary range added.",
    steps=[],
    result="hiring-notes.md now also gives the salary range.",
    validation=[],
    issues=[],
)


async def nth_approval(platform, run_id: str, n: int, timeout: float = 10.0) -> dict:
    """The n-th approval request (1-based) of a task: the Coordinator's plan comes first."""
    import asyncio
    import time

    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        requested = events_of(platform, run_id, "approval.requested")
        if len(requested) >= n:
            return requested[n - 1]
        await asyncio.sleep(0.02)
    raise AssertionError(f"no approval request #{n} for {run_id}")


async def approve_plan(platform, run_id: str) -> None:
    """Approve the Coordinator's plan outside the interface (tasks the test sets up in the background)."""
    plan = await nth_approval(platform, run_id, 1)
    assert plan["data"]["tool"] == "agent_run_plan", "every Coordinator task starts with a plan to check"
    await platform.manager.approvals.decide(plan["data"]["approval_id"], True, None, "owner")


async def shot(page, name: str, full_page: bool = True) -> None:  # noqa: F811
    """Save a picture of the screen when PAE_E2E_SHOTS names a folder (to look at the screens; off otherwise)."""
    import os

    folder = os.environ.get("PAE_E2E_SHOTS")
    if folder:
        Path(folder).mkdir(parents=True, exist_ok=True)
        await page.wait_for_timeout(300)  # let transitions settle
        # Pop-up notices pile up during a fast scripted run: leave them out of the picture.
        toasts = '[role="status"][aria-live="polite"].fixed { display: none !important; }'
        hide = await page.add_style_tag(content=toasts)
        await page.screenshot(path=str(Path(folder) / f"{name}.png"), full_page=full_page)
        await hide.evaluate("style => style.remove()")


async def script_next_follow_up(page, scripts: dict, root: str = "orchestrator") -> None:  # noqa: F811
    """Add the test double's scripts to the next follow-up the page starts (POST /api/runs/{id}/follow-up).
    `root` is the team member the follow-up goes to."""
    from urllib.parse import urlparse

    async def handle(route, request):
        body = json.loads(request.post_data or "{}")
        body["provider"] = "scripted"
        body["options"] = {"provider_options": {"script": scripts[root]}, "tree": {"scripts": scripts}}
        await route.continue_(post_data=json.dumps(body))

    await page.route(lambda url: urlparse(url).path.endswith("/follow-up"), handle, times=1)


async def script_next_task(page, scripts: dict) -> None:  # noqa: F811
    """Add the test double's scripts to the next task the page starts (the one POST /api/runs)."""
    from urllib.parse import urlparse

    def start_request(url: str) -> bool:
        parsed = urlparse(url)
        return parsed.path == "/api/runs" and not parsed.query

    async def handle(route, request):
        if request.method != "POST":
            await route.fallback()
            return
        body = json.loads(request.post_data or "{}")
        root = body.get("agent_id") or "orchestrator"
        body["provider"] = "scripted"
        body.setdefault("options", {})["provider_options"] = {"script": scripts[root]}
        body["options"]["tree"] = {"scripts": scripts}
        await route.continue_(post_data=json.dumps(body))

    await page.route(start_request, handle, times=1)


async def sign_up(page, base: str) -> None:  # noqa: F811
    from playwright.async_api import expect

    await page.goto(base)
    await page.locator("#setup-username").fill("owner")
    await page.locator("#setup-password").fill(PASSWORD)
    await page.locator("#setup-confirm").fill(PASSWORD)
    await page.locator("#setup-token").fill(TEST_SETUP_TOKEN)
    await page.get_by_role("button", name="Create owner account").click()
    await expect(page.get_by_label("What would you like to accomplish?")).to_be_visible()


async def nav_to(page, label: str) -> None:  # noqa: F811
    await (
        page.get_by_role("navigation", name="Main").get_by_role("link", name=re.compile(f"^{re.escape(label)}")).click()
    )


async def no_sideways_scroll(page, path: str) -> None:  # noqa: F811
    overflow = await page.evaluate("document.documentElement.scrollWidth - window.innerWidth")
    culprits = await page.evaluate(WIDEST)
    assert overflow <= 1, f"{path} scrolls sideways by {overflow}px: {culprits}"


async def test_desktop_journey_from_home_to_results(page, server, platform):  # noqa: F811
    from playwright.async_api import expect

    base = server
    await page.set_viewport_size({"width": 1366, "height": 900})
    await sign_up(page, base)

    # 0. Light screens by default; the switch at the bottom of the menu changes them.
    is_dark = "document.documentElement.classList.contains('dark')"
    assert await page.evaluate(is_dark) is False
    await page.get_by_role("button", name="Switch to dark screens").click()
    assert await page.evaluate(is_dark) is True
    await shot(page, "tour-home-dark", full_page=False)
    await page.reload()
    await expect(page.get_by_label("What would you like to accomplish?")).to_be_visible()
    assert await page.evaluate(is_dark) is True, "the choice is kept"
    await page.get_by_role("button", name="Switch to light screens").click()
    assert await page.evaluate(is_dark) is False

    # 1. Home says what the platform is for, and the navigation speaks the owner's language.
    nav = page.get_by_role("navigation", name="Main")
    for label in NAV:
        await expect(nav.get_by_role("link", name=re.compile(f"^{re.escape(label)}"))).to_be_visible()
    await expect(page.get_by_text("Ideas to get started")).to_be_visible()
    await expect(page.get_by_text("Test mode: answers come from a script, not an AI model").first).to_be_visible()
    await shot(page, "tour-home", full_page=False)

    # 2. Discover the team: plain profiles, and "Ask" leads back to Home with that team member chosen.
    await nav.get_by_role("link", name="My AI Team").click()
    await expect(page.get_by_role("heading", name="My AI Team", level=1)).to_be_visible()
    for name in ("Coordinator", "Researcher", "Technical Writer", "Document Specialist"):
        await expect(page.get_by_text(name, exact=True).first).to_be_visible()
    await expect(page.get_by_text("Grader", exact=True)).to_have_count(1)  # only in "Behind the scenes"
    await shot(page, "tour-team", full_page=False)
    await page.goto(f"{base}/team/research")
    await expect(page.get_by_role("heading", name="Researcher", level=1)).to_be_visible()
    await expect(page.get_by_text("Useful when").first).to_be_visible()
    await shot(page, "tour-team-member", full_page=False)
    await page.get_by_role("link", name=re.compile("^Ask Researcher")).first.click()
    await expect(page.get_by_label("What would you like to accomplish?")).to_be_visible()
    await expect(page.get_by_text("Researcher").first).to_be_visible()

    # 3. Back to Home from the navigation. The Researcher is still chosen (and says so); let the
    #    Coordinator decide instead, then create a project inline.
    await nav.get_by_role("link", name="Home").click()
    await page.get_by_role("button", name="Change", exact=True).click()
    await page.get_by_label("Who should work on it?").select_option(label="Let the Coordinator decide (recommended)")
    await page.get_by_label("What would you like to accomplish?").fill("Prepare hiring notes for the backend role")
    await page.get_by_label("Which project is this for?").select_option(label="New project…")
    await page.get_by_label("Project name").fill("Hiring pipeline")
    await page.get_by_label("Notes for your team (optional)").fill("Candidates are anonymised.")
    await page.get_by_role("button", name="Create project").click()
    await expect(page.get_by_label("Which project is this for?")).to_have_value("hiring-pipeline")
    project = platform.projects.get("hiring-pipeline")
    assert project and project["context"] == "Candidates are anonymised."
    folder = Path(project["workspace"])

    # 4. Start: the page opens the Live Workspace on the real task.
    await script_next_task(page, team_scripts())
    await page.get_by_role("button", name="Start").click()
    await page.wait_for_url(re.compile(r"/workspace/[0-9a-f]{32}"))
    run_id = page.url.rsplit("/", 1)[-1].split("?")[0]
    with platform.db.session() as session:
        from pae.db import Run

        root = session.get(Run, run_id)
        assert root.agent_id == "orchestrator" and root.project_id == "hiring-pipeline"

    # 5. The Coordinator proposes its plan first: nothing starts before the owner checks it.
    plan = page.get_by_role("region", name="The Coordinator proposes this plan")
    await expect(plan.get_by_text("1. Researcher — Collect hiring constraints")).to_be_visible()
    await expect(plan.get_by_text("2. Technical Writer — Write the hiring notes (after 1)")).to_be_visible()
    assert not events_of(platform, run_id, "task.started"), "no step starts before the plan is checked"
    await shot(page, "tour-plan", full_page=False)
    await plan.get_by_role("button", name="Start the plan").click()

    # Follow it: who works on what, what was handed over, and a clear approval.
    steps = page.get_by_role("list", name="Steps")
    await expect(steps.get_by_text("Collect hiring constraints")).to_be_visible()
    await expect(steps.get_by_text("Write the hiring notes")).to_be_visible()
    await expect(page.get_by_role("heading", name="Needs your approval")).to_be_visible()
    await expect(steps.get_by_text(re.compile("Received from"))).to_be_visible()
    card = page.get_by_role("article", name="Approval request: Create a file").first
    await expect(
        card.get_by_text("Technical Writer wants to create the file “hiring-notes.md” in the project folder.")
    ).to_be_visible()
    assert not (folder / "hiring-notes.md").exists(), "nothing happens before the owner decides"
    await shot(page, "tour-approval", full_page=False)
    await card.get_by_role("button", name="Approve").click()

    # 6. The consolidated result, the steps' results and the activity, all from the real run.
    await expect(page.get_by_text("Final result", exact=True)).to_be_visible()
    await expect(page.get_by_text("hiring-notes.md now lists the three hiring constraints.").first).to_be_visible()
    # Formatting is shown as formatting: a real table with bold text, no Markdown symbols.
    await expect(page.get_by_role("columnheader", name="Constraint").first).to_be_visible()
    await expect(page.get_by_role("cell", name="Anonymised candidates").first).to_be_visible()
    assert await page.get_by_text("|---|").count() == 0
    await shot(page, "tour-result", full_page=False)
    assert (await wait_for(platform, run_id))["status"] == "completed"
    assert (folder / "hiring-notes.md").read_text() == "# Hiring notes\n", "written in the project's own folder"
    research_step = page.get_by_role("article", name="Step 1: Collect hiring constraints")
    await research_step.get_by_role("button", name="Show the full result").click()
    await expect(research_step.get_by_text("Candidates are anonymised")).to_be_visible()
    await expect(research_step.get_by_text("What is the salary range?")).to_be_visible()
    await expect(page.get_by_text(re.compile("passed its results to Technical Writer")).first).to_be_visible()

    # 7. The detailed map is there for those who want it, built from the same recorded events.
    await page.get_by_role("button", name="Detailed map").click()
    await expect(page.locator('[data-node-id^="result:"]')).to_have_attribute("data-status", "completed")
    await shot(page, "tour-map", full_page=False)
    approvals = page.locator('[data-node-id^="approval:"]')
    await expect(approvals).to_have_count(2)  # the plan, then the new file
    for index in range(2):
        await expect(approvals.nth(index)).to_have_attribute("data-status", "approved")
    await page.get_by_role("button", name="Steps").click()

    # 7b. Continue the finished task with a new instruction: a new task in the same project, linked back.
    await script_next_follow_up(page, {"orchestrator": [FOLLOW_UP]})
    await page.get_by_placeholder("What next?").fill("Add the salary range to the notes")
    await page.get_by_role("button", name="Continue", exact=True).click()
    await page.wait_for_url(lambda url: "/workspace/" in url and run_id not in url)
    follow_id = page.url.rsplit("/", 1)[-1].split("?")[0]
    follows = page.get_by_role("link", name=re.compile("^Follows: “Prepare hiring notes for the backend role”"))
    await expect(follows).to_be_visible()
    assert await follows.get_attribute("href") == f"/workspace/{run_id}"
    await expect(page.get_by_text("Final result", exact=True)).to_be_visible()
    assert (await wait_for(platform, follow_id))["status"] == "completed"
    with platform.db.session() as session:
        followed = session.get(Run, follow_id)
        assert followed.project_id == "hiring-pipeline" and followed.options["follow_up_of"] == run_id

    # 8. Find the work again in My Work (the follow-up is marked as such), and open it.
    await nav.get_by_role("link", name="My Work").click()
    await expect(page.get_by_text("follow-up", exact=True).first).to_be_visible()
    item = page.get_by_role("link", name=re.compile("Prepare hiring notes for the backend role")).first
    await expect(item).to_be_visible()
    await shot(page, "tour-my-work", full_page=False)
    await item.click()
    await page.wait_for_url(re.compile(f"/workspace/{run_id}"))

    # 9. Approvals in plain words: reject a file change requested by another task.
    other = await platform.manager.submit(
        task="Draft a welcome note",
        agent_id="orchestrator",
        project_id="hiring-pipeline",
        options={
            "provider_options": {"script": team_scripts("welcome.md")["orchestrator"]},
            "tree": {"scripts": team_scripts("welcome.md")},
        },
    )
    await approve_plan(platform, other)
    await nth_approval(platform, other, 2)
    await nav.get_by_role("link", name=re.compile("^Approvals")).click()
    request = page.get_by_role("article", name="Approval request: Create a file").first
    await expect(
        request.get_by_text("Technical Writer wants to create the file “welcome.md” in the project folder.")
    ).to_be_visible()
    await expect(request.get_by_text(re.compile("Draft a welcome note"))).to_be_visible()
    await shot(page, "tour-approvals", full_page=False)
    await request.get_by_role("button", name="Reject").click()
    await expect(page.get_by_text(re.compile("Rejected")).first).to_be_visible()
    assert (await wait_for(platform, other))["status"] == "completed"
    assert not (folder / "welcome.md").exists()

    # 9b. A plan can be sent back: what should change goes to the Coordinator, which proposes another.
    first_plan = team_scripts()["orchestrator"][0]
    research_only = first_plan["tool_calls"][0]["input"]["tasks"][:1]
    revised_plan = {
        "text": "Only the research, as asked.",
        "tool_calls": [{"name": "agent_run_plan", "input": {"tasks": research_only}}],
    }
    revised = await platform.manager.submit(
        task="List the hiring constraints",
        agent_id="orchestrator",
        project_id="hiring-pipeline",
        options={
            "provider_options": {"script": [first_plan, revised_plan, FOLLOW_UP]},
            "tree": {"scripts": {"research": [RESEARCH]}},
        },
    )
    await nth_approval(platform, revised, 1)
    await page.goto(f"{base}/workspace/{revised}")
    proposal = page.get_by_role("region", name="The Coordinator proposes this plan")
    await expect(proposal.get_by_text("start this plan (2 steps)")).to_be_visible()
    await proposal.get_by_role("button", name="Change it").click()
    await proposal.get_by_label("What should change?").fill("Only the research, please")
    await proposal.get_by_role("button", name="Change it").click()
    await expect(proposal.get_by_text("start this plan (1 step)")).to_be_visible()
    await proposal.get_by_role("button", name="Start the plan").click()
    assert (await wait_for(platform, revised))["status"] == "completed"
    with platform.db.session() as session:
        assert "Only the research, please" in str(session.get(Run, revised).checkpoint["messages"])

    # 10. Pause, resume and stop a longer task from its page.
    slow = await platform.manager.submit(
        task="Research the hiring market",
        agent_id="orchestrator",
        project_id="hiring-pipeline",
        options={
            "provider_options": {"script": team_scripts()["orchestrator"]},
            "tree": {"scripts": team_scripts(research_delay=30)},
        },
    )
    await approve_plan(platform, slow)
    await wait_event(platform, slow, "task.started")
    await page.goto(f"{base}/workspace/{slow}")
    await page.get_by_role("button", name="Pause").click()
    await expect(page.get_by_role("button", name="Resume")).to_be_visible()
    assert platform.manager.is_paused(slow)
    await page.get_by_role("button", name="Resume").click()
    await expect(page.get_by_role("button", name="Pause")).to_be_visible()
    await page.get_by_role("button", name="Stop", exact=True).click()
    await page.get_by_role("button", name="Stop the task").click()
    assert (await wait_for(platform, slow))["status"] == "cancelled"
    await expect(page.get_by_text("Stopped").first).to_be_visible()

    # 11. Home shows the finished work; Settings and Tools are one click away.
    await nav.get_by_role("link", name="Home").click()
    await expect(page.get_by_text("Prepare hiring notes for the backend role").first).to_be_visible()
    await nav.get_by_role("link", name="Settings").click()
    await expect(page.get_by_text("Claude subscription").first).to_be_visible()
    await shot(page, "tour-settings", full_page=False)
    await nav.get_by_role("link", name="Tools & Connections").click()
    await expect(page.get_by_role("heading", name="Tools & Connections", level=1)).to_be_visible()
    agents = page.get_by_role("region", name="AI agents")
    await expect(agents.get_by_text("Gemini CLI").first).to_be_visible()
    await page.locator("#ai-agents").evaluate("heading => heading.scrollIntoView({block: 'start'})")
    await shot(page, "tour-agents", full_page=False)

    assert not [e for e in page.errors if "401" not in e], page.errors


async def test_phone_journey(page, server, platform):  # noqa: F811
    from playwright.async_api import expect

    base = server
    await page.set_viewport_size({"width": 390, "height": 844})
    await sign_up(page, base)

    # The menu button opens the same navigation.
    await page.get_by_role("button", name="Open navigation").click()
    menu = page.get_by_role("dialog", name="Navigation")
    await menu.get_by_role("link", name="My AI Team").click()
    await expect(page.get_by_role("heading", name="My AI Team", level=1)).to_be_visible()
    await page.get_by_role("button", name="Open navigation").click()
    await page.get_by_role("dialog", name="Navigation").get_by_role("link", name="Home").click()

    # Start a task from a suggestion, in the owner's own words.
    await page.get_by_role("button", name=re.compile("^Research a topic")).click()
    box = page.get_by_label("What would you like to accomplish?")
    await box.fill("Find the three most important hiring constraints in our notes.")
    await script_next_task(page, {"research": [RESEARCH]})
    await page.get_by_role("button", name="Start").click()
    await page.wait_for_url(re.compile(r"/workspace/[0-9a-f]{32}"))
    run_id = page.url.rsplit("/", 1)[-1].split("?")[0]
    await expect(page.get_by_text("Final result", exact=True)).to_be_visible()
    await expect(page.get_by_text("Three hiring constraints found").first).to_be_visible()
    with platform.db.session() as session:
        from pae.db import Run

        assert session.get(Run, run_id).agent_id == "research", "the suggestion chose the Researcher"

    # Approve from the phone.
    approval_run = await platform.manager.submit(
        task="Draft the notes",
        agent_id="orchestrator",
        options={
            "provider_options": {"script": team_scripts("notes.md")["orchestrator"]},
            "tree": {"scripts": team_scripts("notes.md")},
        },
    )
    await nth_approval(platform, approval_run, 1)
    await page.goto(f"{base}/approvals")
    plan_card = page.get_by_role("article", name="Approval request: Check the plan").first
    await plan_card.get_by_role("button", name="Start the plan").click()
    await nth_approval(platform, approval_run, 2)
    await page.goto(f"{base}/approvals")
    card = page.get_by_role("article", name="Approval request: Create a file").first
    await card.get_by_role("button", name="Approve").click()
    assert (await wait_for(platform, approval_run))["status"] == "completed"

    # No screen scrolls sideways on a phone.
    from playwright.async_api import expect as _expect

    for path in (
        "/",
        "/workspace",
        f"/workspace/{run_id}",
        f"/workspace/{approval_run}",
        "/work",
        "/approvals",
        "/team",
        "/team/orchestrator",
        "/team/orchestrator/settings",
        "/projects",
        "/projects/new",
        "/tools",
        "/settings",
        f"/runs/{approval_run}",
    ):
        await page.goto(f"{base}{path}")
        await _expect(page.locator("h1").first).to_be_visible()
        await page.wait_for_timeout(250)
        await no_sideways_scroll(page, path)

    assert not [e for e in page.errors if "401" not in e], page.errors


async def test_project_wizard_and_old_addresses(page, server, platform):  # noqa: F811
    from playwright.async_api import expect

    base = server
    await sign_up(page, base)
    await page.goto(f"{base}/projects/new")
    await page.locator("#project-name").fill("Personal website")
    next_button = page.get_by_role("button", name="Next")
    await next_button.click()  # folder: the platform creates it
    await next_button.click()  # notes for the team
    await page.locator("#project-context").fill("A static site. Keep the tone friendly.")
    await next_button.click()  # check and create
    await page.get_by_role("button", name="Create the project").click()
    await expect(page.get_by_role("heading", name="Project created")).to_be_visible()
    assert platform.projects.get("personal-website")["context"].startswith("A static site")
    await page.get_by_role("button", name=re.compile("Start a task in this project")).click()
    await expect(page.get_by_label("Which project is this for?")).to_have_value("personal-website")

    # Former addresses lead to the same place in the new navigation; removed screens lead to where
    # their work is done now (quality checks are gone; tasks start from Home).
    for old, new in (
        ("/agents", "/team"),
        ("/history", "/work"),
        ("/evals", "/team"),
        ("/team/checks", "/team"),
        ("/agents/research", "/team/research"),
        ("/runs/new", "/"),
    ):
        await page.goto(f"{base}{old}")
        await page.wait_for_url(re.compile(f"{re.escape(new)}$"))

    assert not [e for e in page.errors if "401" not in e], page.errors


# ------------------------------------------------------------------ a code project: straight to the engineer

ENGINEER_CHANGE = final_answer(
    status="complete",
    summary="The export of the candidates is there, for admins.",
    files_changed=["app/export.py"],
    verification={"command": "pytest -m 'not network'", "result": "41 passed", "passed": True},
    follow_ups=[],
    issues=[],
)
REVIEW_BLOCKS = final_answer(
    status="complete",
    summary="The export route returns every candidate to any signed-in user.",
    verdict="block",
    scope=["app/export.py"],
    findings=[
        {
            "severity": "high",
            "category": "access control",
            "file": "app/export.py",
            "line": 12,
            "issue": "no role check",
            "exploit": "a recruiter calls GET /export",
            "fix": "require the admin role",
        }
    ],
    checked=["route roles"],
    issues=[],
)
REVIEW_PASSES = final_answer(
    status="complete",
    summary="The export now asks for the admin role. Nothing blocks.",
    verdict="pass",
    scope=["app/export.py"],
    findings=[],
    checked=["route roles"],
    issues=[],
)


def write_export(content: str, mode: str = "create") -> dict:
    write = {"name": "fs_write", "input": {"path": "app/export.py", "content": content, "mode": mode}}
    return {"text": "Writing the export.", "tool_calls": [write]}


async def test_direct_journey_in_a_code_project(page, server, platform, config, monkeypatch):  # noqa: F811
    """The owner's everyday path: a request in a code project goes straight to the Software Engineer (no plan,
    no approval in "approve everything" mode), the Security Engineer reviews the change, and one button sends
    what blocks back to the engineer."""
    from playwright.async_api import expect

    from pae.db import Run
    from pae.runtime import security_review

    platform.settings.set("security.review_changes", True)
    platform.settings.set("permissions.mode", "all")
    platform.settings.set("notifications.windows", True)
    monkeypatch.setattr(security_review, "POLL_S", 0.05)
    sent: list = []
    platform.manager.notify = lambda *args: sent.append(args) or True
    # Home only starts a member whose AI access is ready: here, the labelled test double instead of Claude Code.
    platform.registry.update_overrides("software-engineering", {"provider": "scripted"})

    folder = config.workspace_roots[0] / "shop-app"
    (folder / "app").mkdir(parents=True)
    (folder / "pyproject.toml").write_text('[project]\nname = "shop-app"\n')
    platform.projects.create(name="Shop app", actor="owner", workspace=str(folder))

    base = server
    await page.set_viewport_size({"width": 1366, "height": 900})
    await sign_up(page, base)

    # 1. Home: in a code project the Software Engineer takes the request, and says so.
    await page.get_by_label("Which project is this for?").select_option(label="Shop app")
    await expect(page.get_by_text("works on it directly, like Claude Code.")).to_be_visible()
    await page.get_by_label("What would you like to accomplish?").fill("Add an export of the candidates for admins")
    await shot(page, "direct-1-home")

    # 2. Start: no plan to check, no approval to give; the file is written and the result is there.
    scripts = {"software-engineering": [write_export("# everyone\n"), ENGINEER_CHANGE], "security": [REVIEW_BLOCKS]}
    await script_next_task(page, scripts)
    await page.get_by_role("button", name="Start").click()
    await page.wait_for_url(re.compile(r"/workspace/[0-9a-f]{32}"))
    run_id = page.url.rsplit("/", 1)[-1].split("?")[0]
    await expect(page.get_by_text("Final result", exact=True)).to_be_visible()
    await expect(page.get_by_text("The export of the candidates is there, for admins.").first).to_be_visible()
    assert (await wait_for(platform, run_id))["status"] == "completed"
    assert (folder / "app" / "export.py").read_text() == "# everyone\n"
    assert not events_of(platform, run_id, "approval.requested"), "approve everything: nothing to approve"
    with platform.db.session() as session:
        root = session.get(Run, run_id)
        assert root.agent_id == "software-engineering" and root.project_id == "shop-app"
    await shot(page, "direct-2-result")
    # What changed and whether its own check passed, without opening anything.
    await expect(page.get_by_text("File changed")).to_be_visible()
    await expect(page.get_by_text("app/export.py", exact=True).first).to_be_visible()
    await expect(page.get_by_text("Passed", exact=True)).to_be_visible()
    await expect(page.get_by_text("41 passed (pytest -m 'not network')")).to_be_visible()

    # 3. The Security Engineer reviews the change on its own; the task's page says where the review stands.
    def reviews_of(change_id: str) -> list:
        with platform.db.session() as session:
            return [
                r.id
                for r in session.query(Run).filter(Run.agent_id == "security").order_by(Run.created_at)
                if (r.options or {}).get("reviews_change_of") == change_id
            ]

    note = page.get_by_role("status").filter(has_text="Security Engineer")
    await expect(note).to_contain_text("Security Engineer blocked this change.")
    [review_id] = reviews_of(run_id)
    await shot(page, "direct-3-blocked-note")
    await note.get_by_role("link", name="See what blocks").click()
    await page.wait_for_url(re.compile(f"/workspace/{review_id}"))

    # 4. The review: a plain title, a verdict nobody can miss, and the findings in sight.
    await expect(
        page.get_by_role("heading", name="Security review: Add an export of the candidates for admins")
    ).to_be_visible()
    await expect(page.get_by_text("Blocks the change").first).to_be_visible()
    await expect(page.get_by_text("Fully done")).to_have_count(0)
    assert await page.get_by_text("untrusted_data").count() == 0, "the team's instructions are not the owner's reading"
    found = page.get_by_role("list", name="What the review found")
    await expect(found.get_by_text("no role check")).to_be_visible()
    await expect(found.get_by_text("app/export.py:12")).to_be_visible()
    await expect(found.get_by_text("require the admin role")).to_be_visible()
    await expect(
        page.get_by_role("link", name=re.compile("^Follows: “Add an export of the candidates for admins”"))
    ).to_be_visible()
    await shot(page, "direct-4-review")
    for _ in range(100):
        if sent:
            break
        await page.wait_for_timeout(50)
    title, body, url = sent[0]
    assert title == "Security Engineer blocked a change" and url.endswith(f"/workspace/{review_id}")

    # 5. One button sends what blocks to the engineer, who fixes it; the new change is reviewed too, and passes.
    fix_scripts = {
        "software-engineering": [write_export("# admins only\n", "overwrite"), ENGINEER_CHANGE],
        "security": [REVIEW_PASSES],
    }
    await script_next_follow_up(page, fix_scripts, root="software-engineering")
    await page.get_by_role("button", name="Fix what blocks").click()
    await page.wait_for_url(lambda url: "/workspace/" in url and review_id not in url)
    fix_id = page.url.rsplit("/", 1)[-1].split("?")[0]
    await expect(page.get_by_text("Final result", exact=True)).to_be_visible()
    assert (await wait_for(platform, fix_id))["status"] == "completed"
    assert (folder / "app" / "export.py").read_text() == "# admins only\n"
    with platform.db.session() as session:
        fixing = session.get(Run, fix_id)
        assert fixing.agent_id == "software-engineering" and "no role check" in fixing.task
    await expect(page.get_by_role("status").filter(has_text="Security Engineer")).to_contain_text("nothing blocks")
    await shot(page, "direct-5-fixed")

    # 6. My Work tells the three apart: the change, the review that blocked it, the fix and its review.
    await nav_to(page, "My Work")
    await expect(page.get_by_text("Blocks the change")).to_have_count(1)
    await expect(page.get_by_text("Nothing blocks")).to_have_count(1)
    assert await page.get_by_text("untrusted_data").count() == 0
    await shot(page, "direct-6-my-work")

    assert not [e for e in page.errors if "401" not in e], page.errors
