"""Projects: isolated workspaces, project context, project-scoped secrets, and runs of
different projects executing at the same time without mixing files, credentials or events.
Also the Agent Workspace HTTP API (graph, executions, pause)."""

from __future__ import annotations

import asyncio
import shutil
import tempfile
from pathlib import Path

import httpx
import pytest

from pae.app import create_app
from pae.db import Run
from pae.runtime.native import build_system_prompt
from pae.tools.base import Args, Tool, ToolResult

from conftest import TEST_SETUP_TOKEN, call, events_of, final, wait_event, wait_for

pytestmark = pytest.mark.anyio
PASSWORD = "a-long-test-password"


@pytest.fixture
async def client(platform, config):
    app = create_app(config, platform=platform)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://testserver") as c:
        yield c


@pytest.fixture
async def csrf(client) -> dict:
    response = await client.post(
        "/api/auth/setup", json={"username": "owner", "password": PASSWORD, "setup_token": TEST_SETUP_TOKEN}
    )
    assert response.status_code == 200, response.text
    return {"x-csrf-token": response.json()["csrf_token"]}


async def create(client, csrf, name: str, **body) -> dict:
    response = await client.post("/api/projects", headers=csrf, json={"name": name, **body})
    assert response.status_code == 200, response.text
    return response.json()


def delegating_script(delay: float = 0.0) -> dict:
    """tester delegates to helper (a real child run), then answers."""
    return {
        "provider_options": {"script": [call("agent_delegate", agent_id="helper", task="look at the files"), final()]},
        "tree": {"scripts": {"helper": [{"delay_s": delay, "text": "helper report"}]}},
    }


# ------------------------------------------------------------ project lifecycle


async def test_project_lifecycle(client, csrf, platform):
    project = await create(client, csrf, "Recruitment pipeline", context="Candidates are anonymised.", tags=["hr"])
    assert project["id"] == "recruitment-pipeline" and project["stats"] == {"runs": 0, "active": 0, "last_run_at": None}
    folder = Path(project["workspace"])
    assert folder.is_dir() and folder.parent == platform.config.workspace_roots[0].resolve()
    assert (await create(client, csrf, "Recruitment pipeline"))["id"] == "recruitment-pipeline-2"

    patched = await client.patch(f"/api/projects/{project['id']}", headers=csrf, json={"context": "Use French."})
    assert patched.json()["context"] == "Use French."
    moved = await client.patch(f"/api/projects/{project['id']}", headers=csrf, json={"workspace": "/elsewhere"})
    assert moved.status_code == 200 and moved.json()["workspace"] == project["workspace"], "workspace is fixed"

    run = await client.post(
        "/api/runs",
        headers=csrf,
        json={
            "task": "x",
            "agent_id": "tester",
            "project_id": project["id"],
            "options": {"provider_options": {"script": [final()]}},
        },
    )
    assert run.status_code == 200, run.text
    await wait_for(platform, run.json()["run_id"])
    listed = (await client.get("/api/projects")).json()["items"]
    assert next(p for p in listed if p["id"] == project["id"])["stats"]["runs"] == 1
    assert (await client.delete(f"/api/projects/{project['id']}", headers=csrf)).status_code == 409

    await client.patch(f"/api/projects/{project['id']}", headers=csrf, json={"archived": True})
    assert project["id"] not in {p["id"] for p in (await client.get("/api/projects")).json()["items"]}
    archived = (await client.get("/api/projects?include_archived=true")).json()["items"]
    assert project["id"] in {p["id"] for p in archived}
    refused = await client.post(
        "/api/runs", headers=csrf, json={"task": "x", "agent_id": "tester", "project_id": project["id"]}
    )
    assert refused.status_code == 400 and "archived" in refused.text

    assert (await client.delete("/api/projects/recruitment-pipeline-2", headers=csrf)).json() == {
        "deleted": "recruitment-pipeline-2"
    }
    assert (await client.get("/api/projects/recruitment-pipeline-2")).status_code == 404


async def test_project_workspaces_never_overlap_and_stay_inside_the_roots(client, csrf, platform, tmp_path):
    alpha = await create(client, csrf, "Alpha")
    inside = Path(alpha["workspace"]) / "sub"
    overlap = await client.post("/api/projects", headers=csrf, json={"name": "Nested", "workspace": str(inside)})
    assert overlap.status_code == 409 and "overlaps project 'alpha'" in overlap.text
    root = platform.config.workspace_roots[0]
    contains = await client.post("/api/projects", headers=csrf, json={"name": "Root", "workspace": str(root)})
    assert contains.status_code == 400
    missing = await client.post(
        "/api/projects", headers=csrf, json={"name": "Outside", "workspace": str(tmp_path / "elsewhere")}
    )
    assert missing.status_code == 400 and "does not exist" in missing.text
    assert not (tmp_path / "elsewhere").exists(), "nothing is created outside the roots"


async def test_an_existing_folder_anywhere_can_be_a_project(client, csrf, platform, tmp_path):
    folder = tmp_path / "Shop-App" / "application"
    (folder / "backups").mkdir(parents=True)
    (folder / "src").mkdir()
    (folder / "src" / "score.py").write_text("WEIGHT = 3\n")
    (folder / "backups" / "dump.sql").write_text("INSERT INTO customers VALUES ('Ada')\n")
    project = await create(client, csrf, "Shop", workspace=str(folder), private_paths=["backups/", "./logs", "backups"])
    assert project["external"] is True and Path(project["workspace"]) == folder.resolve()
    assert project["private_paths"] == ["backups", "logs"]

    # The team works in that folder, but never opens, lists or searches the private paths.
    script = [
        call("fs_read", path="src/score.py"),
        call("fs_read", path="backups/dump.sql"),
        call("fs_list", path=".", recursive=True),
        call("fs_search", pattern="customers"),
        {"text": "done"},
    ]
    platform.registry.save_custom(
        {
            "id": "looker",
            "name": "Looker",
            "description": "reads",
            "provider": "scripted",
            "instructions": "Read.",
            "tools": ["fs_read", "fs_list", "fs_search"],
        },
        create=True,
    )
    run_id = await platform.manager.submit(
        task="look", agent_id="looker", project_id="shop", options={"provider_options": {"script": script}}
    )
    await wait_for(platform, run_id)
    failed = [e["data"]["error"] for e in events_of(platform, run_id, "tool.failed")]
    assert len(failed) == 1 and "private" in failed[0]
    outputs = {e["data"]["tool"]: e["data"]["output"] for e in events_of(platform, run_id, "tool.completed")}
    assert "WEIGHT" in outputs["fs_read"]
    assert "score.py" in outputs["fs_list"] and "dump.sql" not in outputs["fs_list"]
    assert "Ada" not in outputs["fs_search"]

    # Claude Code's own file tools go through the same check.
    from pae.tools.base import ToolError, resolve_path

    with pytest.raises(ToolError, match="private"):
        resolve_path(folder, "backups/dump.sql")

    # Changing the private paths applies at once.
    await client.patch("/api/projects/shop", headers=csrf, json={"private_paths": []})
    assert resolve_path(folder, "backups/dump.sql").name == "dump.sql"
    bad = await client.patch("/api/projects/shop", headers=csrf, json={"private_paths": ["../other"]})
    assert bad.status_code == 400


async def test_unsafe_folders_are_refused(client, csrf, platform, tmp_path):
    import os

    places = [Path(tmp_path.anchor), Path.home(), platform.config.data_dir]
    if os.environ.get("SystemRoot"):
        places.append(Path(os.environ["SystemRoot"]))
    for place in places:
        response = await client.post("/api/projects", headers=csrf, json={"name": "Unsafe", "workspace": str(place)})
        assert response.status_code == 400, place
    assert not [p for p in (await client.get("/api/projects")).json()["items"] if p["name"] == "Unsafe"]


async def test_project_scaffold_reports_conflicts(client, csrf):
    project = await create(client, csrf, "Scaffolded", scaffold=["base"])
    assert project["files"], "templates were written into the project folder"
    again = await client.post(f"/api/projects/{project['id']}/scaffold", headers=csrf, json={"capabilities": ["base"]})
    assert again.status_code == 409 and again.json()["detail"]["conflicts"]


async def test_create_with_a_failing_scaffold_leaves_no_half_created_project(client, csrf, platform):
    root = platform.config.workspace_roots[0]
    existing = root / "existing-repo"
    existing.mkdir(parents=True)
    (existing / "README.md").write_text("mine")
    response = await client.post(
        "/api/projects", headers=csrf, json={"name": "Existing repo", "workspace": str(existing), "scaffold": ["base"]}
    )
    assert response.status_code == 409 and "README.md" in response.json()["detail"]["conflicts"]
    assert (await client.get("/api/projects/existing-repo")).status_code == 404
    assert (existing / "README.md").read_text() == "mine", "the folder is left as it was"
    retry = await create(client, csrf, "Existing repo", workspace=str(existing))
    assert retry["id"] == "existing-repo", "a corrected retry gets the intended id"


# ------------------------------------------------------------ isolation


async def test_runs_and_their_children_stay_in_the_project_folder(client, csrf, platform):
    alpha, beta = await create(client, csrf, "Alpha"), await create(client, csrf, "Beta")
    run_id = await platform.manager.submit(
        task="work", agent_id="tester", project_id="alpha", options=delegating_script()
    )
    await wait_for(platform, run_id)
    with platform.db.session() as session:
        runs = session.query(Run).filter(Run.root_run_id == run_id).all()
        assert len(runs) == 2
        assert {r.project_id for r in runs} == {"alpha"}
        assert {Path(r.workspace) for r in runs} == {Path(alpha["workspace"])}

    sub = Path(alpha["workspace"]) / "reports"
    sub.mkdir()
    ok = await platform.manager.submit(
        task="x",
        agent_id="tester",
        project_id="alpha",
        workspace=str(sub),
        options={"provider_options": {"script": [final()]}},
    )
    assert Path((await wait_for(platform, ok))["workspace"]) == sub
    escape = await client.post(
        "/api/runs",
        headers=csrf,
        json={"task": "x", "agent_id": "tester", "project_id": "alpha", "workspace": beta["workspace"]},
    )
    assert escape.status_code == 400 and "inside the project's folder" in escape.text
    unknown = await client.post(
        "/api/runs", headers=csrf, json={"task": "x", "agent_id": "tester", "project_id": "nope"}
    )
    assert unknown.status_code == 400


async def test_files_written_in_one_project_are_invisible_to_another(client, csrf, platform):
    alpha, beta = await create(client, csrf, "Alpha"), await create(client, csrf, "Beta")
    (Path(alpha["workspace"]) / "customers.csv").write_text("name\nAda\n")
    run_id = await platform.manager.submit(
        task="read",
        agent_id="tester",
        project_id="beta",
        options={
            "provider_options": {
                "script": [
                    call("fs_read", path="customers.csv"),
                    call("fs_read", path="../alpha/customers.csv"),
                    final(),
                ]
            }
        },
    )
    await wait_for(platform, run_id)
    errors = [e["data"]["error"] for e in events_of(platform, run_id, "tool.failed")]
    assert len(errors) == 2 and "outside the workspace" in errors[1]
    assert not events_of(platform, run_id, "tool.completed")
    assert Path(beta["workspace"]).is_dir()


async def test_secrets_are_scoped_per_project(client, csrf, platform):
    await create(client, csrf, "Alpha")
    await create(client, csrf, "Beta")
    put = await client.put("/api/secrets/SERVICE_TOKEN", headers=csrf, json={"value": "global-token-0001"})
    assert put.json()["project_id"] is None
    scoped = await client.put(
        "/api/secrets/SERVICE_TOKEN?project_id=alpha", headers=csrf, json={"value": "alpha-token-0002"}
    )
    assert scoped.json() == {"name": "SERVICE_TOKEN", "hint": "...0002", "project_id": "alpha"}
    missing = await client.put("/api/secrets/X_TOKEN?project_id=nope", headers=csrf, json={"value": "x" * 12})
    assert missing.status_code == 404

    assert platform.manager.get_secret("SERVICE_TOKEN", "alpha") == "alpha-token-0002"
    assert platform.manager.get_secret("SERVICE_TOKEN", "beta") == "global-token-0001"
    assert platform.manager.get_secret("SERVICE_TOKEN") == "global-token-0001"
    alpha_list = (await client.get("/api/secrets?project_id=alpha")).json()["items"]
    assert sorted((s["name"], s["project_id"] or "") for s in alpha_list) == [
        ("SERVICE_TOKEN", ""),
        ("SERVICE_TOKEN", "alpha"),
    ]
    global_list = (await client.get("/api/secrets")).json()["items"]
    assert [(s["name"], s["project_id"]) for s in global_list] == [("SERVICE_TOKEN", None)]
    assert "alpha-token" not in (await client.get("/api/secrets?project_id=alpha")).text, "values are write-only"

    await client.delete("/api/secrets/SERVICE_TOKEN?project_id=alpha", headers=csrf)
    assert platform.manager.get_secret("SERVICE_TOKEN", "alpha") == "global-token-0001"


class ProbeArgs(Args):
    pass


async def test_concurrent_projects_use_their_own_secrets_context_and_events(client, csrf, platform):
    await create(client, csrf, "Alpha", context="Alpha brief: hiring for Lisbon.")
    await create(client, csrf, "Beta", context="Beta brief: quarterly accounting.")
    await client.put("/api/secrets/SERVICE_TOKEN?project_id=alpha", headers=csrf, json={"value": "alpha-token-0002"})
    await client.put("/api/secrets/SERVICE_TOKEN?project_id=beta", headers=csrf, json={"value": "beta-token-00003"})
    observed: dict[str, dict] = {}

    async def probe(_args, ctx) -> ToolResult:
        await asyncio.sleep(0.2)  # overlap the two runs
        run_ctx = ctx.manager.context_of(ctx.run_id)
        observed[run_ctx.project_id] = {
            "secret": ctx.secrets("SERVICE_TOKEN"),
            "prompt": build_system_prompt(run_ctx),
            "workspace": ctx.workspace,
        }
        return ToolResult("probed")

    platform.manager.tools.register(Tool("probe", "Test probe.", ProbeArgs, probe, "read", "allow", "test"))
    platform.registry.save_custom(
        {
            "id": "prober",
            "name": "Prober",
            "description": "probe",
            "provider": "scripted",
            "instructions": "Probe.",
            "tools": ["probe", "agent_delegate"],
            "delegates": ["helper"],
        },
        create=True,
    )
    options = {
        "provider_options": {
            "script": [
                call("probe"),
                call("agent_delegate", agent_id="helper", task="check the folder"),
                {"text": "done"},
            ]
        },
        "tree": {"scripts": {"helper": [{"delay_s": 0.2, "text": "helper report"}]}},
    }
    alpha_run, beta_run = await asyncio.gather(
        platform.manager.submit(task="alpha work", agent_id="prober", project_id="alpha", options=options),
        platform.manager.submit(task="beta work", agent_id="prober", project_id="beta", options=options),
    )
    await asyncio.gather(wait_for(platform, alpha_run), wait_for(platform, beta_run))

    assert observed["alpha"]["secret"] == "alpha-token-0002" and observed["beta"]["secret"] == "beta-token-00003"
    assert "hiring for Lisbon" in observed["alpha"]["prompt"] and "Lisbon" not in observed["beta"]["prompt"]
    assert observed["alpha"]["workspace"] != observed["beta"]["workspace"]
    with platform.db.session() as session:
        tree = {r.id: r.project_id for r in session.query(Run).filter(Run.root_run_id.in_((alpha_run, beta_run)))}
    for root, project in ((alpha_run, "alpha"), (beta_run, "beta")):
        events = events_of(platform, root)
        assert events and {tree[e["run_id"]] for e in events} == {project}, "a run tree only holds its own events"
    for text in (str(events_of(platform, alpha_run)), str(events_of(platform, beta_run))):
        assert "token-000" not in text, "secret values never reach events"

    executions = (await client.get("/api/workspace/executions?project_id=alpha")).json()["items"]
    assert [e["run_id"] for e in executions] == [alpha_run] and executions[0]["agents"] == ["helper", "prober"]
    runs = (await client.get("/api/runs?project_id=beta")).json()["items"]
    assert [r["id"] for r in runs] == [beta_run] and runs[0]["project_id"] == "beta"


async def test_approvals_are_listed_per_project(client, csrf, platform):
    await create(client, csrf, "Alpha")
    await create(client, csrf, "Beta")
    run_id = await platform.manager.submit(
        task="write",
        agent_id="tester",
        project_id="alpha",
        options={"provider_options": {"script": [call("fs_write", path="a.txt", content="A"), final()]}},
    )
    await wait_event(platform, run_id, "approval.requested")
    alpha = (await client.get("/api/approvals?project_id=alpha")).json()["items"]
    assert len(alpha) == 1 and alpha[0]["project_id"] == "alpha"
    assert (await client.get("/api/approvals?project_id=beta")).json()["items"] == []
    await platform.manager.cancel(run_id)
    await wait_for(platform, run_id)


def test_migration_0002_keeps_existing_secrets_and_runs_as_global(tmp_path):
    import sqlalchemy as sa
    from alembic import command

    from pae.migrations_runner import alembic_config

    url = f"sqlite:///{(tmp_path / 'old.db').as_posix()}"
    config = alembic_config(url)
    command.upgrade(config, "0001")
    engine = sa.create_engine(url)
    with engine.begin() as conn:
        conn.execute(
            sa.text(
                "INSERT INTO secrets (name, ciphertext, hint, created_at, updated_at) "
                "VALUES ('OLD_TOKEN', 'cipher', '...1234', '2026-01-01', '2026-01-01')"
            )
        )
    command.upgrade(config, "head")
    with engine.begin() as conn:
        rows = conn.execute(sa.text("SELECT name, project_id, ciphertext FROM secrets")).all()
        columns = {c["name"] for c in sa.inspect(conn).get_columns("runs")}
        tables = set(sa.inspect(conn).get_table_names())
    engine.dispose()
    assert rows == [("OLD_TOKEN", "", "cipher")], "the existing secret is kept, as a global secret"
    assert "project_id" in columns and "projects" in tables


# ------------------------------------------------------------ workspace API


async def test_graph_executions_and_pause_endpoints(client, csrf, platform):
    run_id = await platform.manager.submit(task="delegate", agent_id="tester", options=delegating_script(delay=0.6))
    started = await wait_event(platform, run_id, "task.started")
    paused = await client.post(f"/api/runs/{run_id}/pause", headers=csrf)
    assert paused.json() == {"paused": True}
    assert (await client.get(f"/api/runs/{run_id}")).json()["run"]["paused"] is True
    child_pause = await client.post(f"/api/runs/{started['data']['child_run_id']}/pause", headers=csrf)
    assert child_pause.status_code == 400
    assert (await client.post(f"/api/runs/{run_id}/unpause", headers=csrf)).json() == {"paused": False}
    await wait_for(platform, run_id)

    graph = (await client.get(f"/api/runs/{started['data']['child_run_id']}/graph")).json()
    assert graph["root_run_id"] == run_id and graph["status"] == "completed" and graph["paused"] is False
    kinds = sorted(n["kind"] for n in graph["nodes"])
    assert kinds == ["result", "root", "task"]
    task_node = next(n for n in graph["nodes"] if n["kind"] == "task")
    assert task_node["agent_id"] == "helper" and task_node["output_preview"] == "helper report"
    assert task_node["usage"]["input_tokens"] > 0 and task_node["usage"]["duration_s"] is not None
    assert (await client.get("/api/runs/nope/graph")).status_code == 404

    executions = (await client.get("/api/workspace/executions")).json()["items"]
    item = next(e for e in executions if e["run_id"] == run_id)
    assert item["tasks"] == {"total": 1, "completed": 1, "failed": 0, "skipped": 0, "running": 0}
    assert item["active_runs"] == 0
    assert item["agents"] == ["helper", "tester"] and item["paused"] is False
    solo = await platform.manager.submit(
        task="solo", agent_id="tester", options={"provider_options": {"script": [final()]}}
    )
    await wait_for(platform, solo)
    ids = {e["run_id"] for e in (await client.get("/api/workspace/executions")).json()["items"]}
    assert solo not in ids, "single-agent runs without delegation are not collaborative executions"
    assert (await client.post(f"/api/runs/{run_id}/pause", headers=csrf)).status_code == 400
    assert (await client.get("/api/workspace/executions")).status_code == 200
    unauth = httpx.AsyncClient(transport=client._transport, base_url="http://testserver")
    async with unauth:
        assert (await unauth.get(f"/api/runs/{run_id}/graph")).status_code == 401


def test_migration_0003_marks_earlier_quality_check_runs(tmp_path):
    import json as _json

    import sqlalchemy as sa
    from alembic import command

    from pae.migrations_runner import alembic_config

    url = f"sqlite:///{(tmp_path / 'old.db').as_posix()}"
    config = alembic_config(url)
    command.upgrade(config, "0002")
    engine = sa.create_engine(url)

    def dummy(column):
        kind = str(column["type"]).upper()
        if any(word in kind for word in ("INT", "FLOAT", "REAL", "NUMERIC", "BOOL")):
            return 0
        if "JSON" in kind:
            return "{}"
        if "DATE" in kind or "TIME" in kind:
            return "2026-01-01 00:00:00"
        return "x"

    with engine.begin() as conn:
        required = [c for c in sa.inspect(conn).get_columns("runs") if not c["nullable"]]
        for run_id, root in (("case1", "case1"), ("child1", "case1"), ("judge1", "judge1"), ("mine", "mine")):
            values = {c["name"]: dummy(c) for c in required}
            values.update(id=run_id, root_run_id=root, kind="agent", status="completed", task="t")
            placeholders = ", ".join(f":{name}" for name in values)
            conn.execute(sa.text(f"INSERT INTO runs ({', '.join(values)}) VALUES ({placeholders})"), values)
        results = [{"case_id": "c", "run_id": "case1", "checks": [{"name": "judge", "judge_run_id": "judge1"}]}]
        conn.execute(
            sa.text(
                "INSERT INTO eval_runs (id, suite, status, summary, results, started_at) "
                "VALUES ('e1', 's', 'completed', '{}', :r, '2026-01-01 00:00:00')"
            ),
            {"r": _json.dumps(results)},
        )
    command.upgrade(config, "head")
    with engine.begin() as conn:
        origins = dict(conn.execute(sa.text("SELECT id, origin FROM runs")).all())
    engine.dispose()
    assert origins == {"case1": "quality_check", "child1": "quality_check", "judge1": "quality_check", "mine": "owner"}


async def test_quality_check_runs_are_kept_apart_from_the_owners_work(client, csrf, platform):
    # Evaluation suites submit with an `eval:<suite>` actor (pae/evals.py).
    mine = await platform.manager.submit(
        task="my task", agent_id="tester", options={"provider_options": {"script": [final()]}}
    )
    check = await platform.manager.submit(
        task="sample", agent_id="tester", actor="eval:runtime-contracts", options=delegating_script()
    )
    await wait_for(platform, mine)
    await wait_for(platform, check)
    with platform.db.session() as session:
        assert {r.origin for r in session.query(Run).filter(Run.root_run_id == check)} == {"quality_check"}
    owner_ids = {r["id"] for r in (await client.get("/api/runs?origin=owner")).json()["items"]}
    assert mine in owner_ids and check not in owner_ids
    all_ids = {r["id"] for r in (await client.get("/api/runs")).json()["items"]}
    assert {mine, check} <= all_ids
    executions = {e["run_id"] for e in (await client.get("/api/workspace/executions")).json()["items"]}
    assert check not in executions
    assert check in {e["run_id"] for e in (await client.get("/api/workspace/executions?origin=all")).json()["items"]}


async def test_a_finished_task_can_be_continued_with_only_its_request_and_result(client, csrf, platform):
    await create(client, csrf, "Alpha")
    first = await platform.manager.submit(
        task="Summarise the notes",
        agent_id="tester",
        project_id="alpha",
        options={"provider_options": {"script": [final("three points")]}},
    )
    await wait_for(platform, first)
    response = await client.post(
        f"/api/runs/{first}/follow-up",
        headers=csrf,
        json={"message": "Now turn it into a checklist", "options": {"provider_options": {"script": [final("ok")]}}},
    )
    assert response.status_code == 200, response.text
    second = response.json()["run_id"]
    run = await wait_for(platform, second)
    assert run["project_id"] == "alpha" and run["agent_id"] == "tester" and run["status"] == "completed"
    assert run["task"].startswith("Now turn it into a checklist\n\n## Earlier task this continues")
    assert "Earlier request: Summarise the notes" in run["task"]
    assert '<untrusted_data source="earlier-result">' in run["task"] and "three points" in run["task"]
    listed = (await client.get("/api/runs?project_id=alpha")).json()["items"]
    assert next(r for r in listed if r["id"] == second)["follow_up_of"] == first

    busy = await platform.manager.submit(
        task="slow", agent_id="tester", options={"provider_options": {"script": [{"delay_s": 5, "text": "x"}]}}
    )
    refused = await client.post(f"/api/runs/{busy}/follow-up", headers=csrf, json={"message": "more"})
    assert refused.status_code == 400 and "still running" in refused.text
    await platform.manager.cancel(busy)


async def test_a_project_can_let_the_team_edit_files_without_asking(client, csrf, platform):
    project = await create(client, csrf, "Trusted")
    assert project["trust_edits"] is False
    patched = await client.patch("/api/projects/trusted", headers=csrf, json={"trust_edits": True})
    assert patched.json()["trust_edits"] is True
    script = [call("fs_write", path="notes.md", content="hello"), call("fs_delete", path="notes.md"), final()]
    run_id = await platform.manager.submit(
        task="edit", agent_id="tester", project_id="trusted", options={"provider_options": {"script": script}}
    )
    requested = await wait_event(platform, run_id, "approval.requested")
    assert requested["data"]["tool"] == "fs_delete", "edits go ahead; deleting still asks"
    assert (Path(project["workspace"]) / "notes.md").read_text() == "hello"
    await platform.manager.approvals.decide(requested["data"]["approval_id"], False, None, "owner")
    await wait_for(platform, run_id)

    from pae.runtime.claude_code import builtin_permission

    class Ctx:
        project_trust_edits = True
        workspace = Path(project["workspace"])
        manager = platform.manager
        options: dict = {}

        class agent:
            claude_code_tools = ["Edit", "Bash"]
            permissions: dict = {}

    assert builtin_permission(Ctx, "Edit", {"file_path": "notes.md"}) == ("allow", "project")
    assert builtin_permission(Ctx, "Bash", {"command": "ls"}) == ("allow", "project"), "reading goes ahead"
    assert builtin_permission(Ctx, "Bash", {"command": "rm notes.md"})[0] == "ask"


async def test_a_project_reuses_claude_codes_memory_for_its_folder(client, csrf, platform, tmp_path, request):
    folder = tmp_path / "Shop-App" / "application"
    folder.mkdir(parents=True)
    other = tmp_path / "Other"
    other.mkdir()
    home = Path(tempfile.mkdtemp(prefix="cc-"))  # short: Windows paths stop at 260 characters
    request.addfinalizer(lambda: shutil.rmtree(home, ignore_errors=True))
    slug = "".join(c if c.isalnum() else "-" for c in str(folder.resolve()))
    memory = home / "projects" / slug.lower() / "memory"  # folder case may differ on Windows
    memory.mkdir(parents=True)
    index = "# Memory index\n\n- [Reject one by one](rejet-un-par-un.md) — never in bulk\n"
    (memory / "MEMORY.md").write_text(index, encoding="utf-8")
    rule = "RULE: never delete orders in bulk; a person checks each one.\n"
    (memory / "rejet-un-par-un.md").write_text(rule, encoding="utf-8")
    platform.projects.claude_home = home

    project = await create(client, csrf, "Shop", workspace=str(folder))
    assert project["claude_memory"]["notes"] == 1 and Path(project["claude_memory"]["folder"]).samefile(memory)
    plain = await create(client, csrf, "Other", workspace=str(other))
    assert plain["claude_memory"] is None

    # Every task starts with the memory index after the owner's notes, like a new Claude Code session.
    context = platform.projects.context("shop")
    assert "## Claude Code's memory for this folder" in context and "never in bulk" in context
    assert "RULE" not in context, "single notes are opened on demand, not all loaded"

    # Any agent working in the project can open one note; nothing outside the memory folder.
    (memory.parent / "secret.md").write_text("outside")
    script = [
        call("project_memory_read", note="rejet-un-par-un.md"),
        call("project_memory_read", note="../secret.md"),
        call("project_memory_read", note="missing.md"),
        call("project_memory_read", note=".hidden.md"),
        final(),
    ]
    run_id = await platform.manager.submit(
        task="read", agent_id="tester", project_id="shop", options={"provider_options": {"script": script}}
    )
    await wait_for(platform, run_id)
    done = [e["data"]["output"] for e in events_of(platform, run_id, "tool.completed")]
    failed = [e["data"]["error"] for e in events_of(platform, run_id, "tool.failed")]
    assert len(done) == 1 and "never delete orders in bulk" in done[0]
    assert len(failed) == 3 and not any("outside" in f for f in failed)

    # A project without a Claude Code memory does not offer the tool.
    run_id = await platform.manager.submit(
        task="read",
        agent_id="tester",
        project_id="other",
        options={"provider_options": {"script": [call("project_memory_read", note="x.md"), final()]}},
    )
    await wait_for(platform, run_id)
    assert "not available" in events_of(platform, run_id, "tool.failed")[0]["data"]["error"]


async def test_claude_code_searches_never_reach_private_folders(client, csrf, platform, tmp_path):
    from pae.runtime.claude_code import builtin_permission

    folder = tmp_path / "app"
    (folder / "backend").mkdir(parents=True)
    (folder / "scripts").mkdir()
    await create(client, csrf, "App", workspace=str(folder), private_paths=["backups", "scripts/backup.conf"])

    class Ctx:
        project_trust_edits = False
        workspace = folder
        manager = platform.manager
        options: dict = {}

        class agent:
            claude_code_tools = ["Grep", "Glob", "Read"]
            permissions: dict = {}

    def decide(tool, **tool_input):
        return builtin_permission(Ctx, tool, tool_input)

    # A search from the project folder (or a folder holding a private file) would read private content.
    assert decide("Grep", pattern="customer")[0] == "deny"
    assert decide("Grep", pattern="customer", path=".")[0] == "deny"
    assert decide("Glob", pattern="**/*.sql")[0] == "deny"
    assert decide("Grep", pattern="x", path="scripts")[0] == "deny"
    assert decide("Grep", pattern="x", path="backups")[0] == "deny"
    # Searching a subfolder without private paths is fine; patterns cannot climb out of it.
    assert decide("Grep", pattern="customer", path="backend") == ("allow", "default")
    assert decide("Glob", pattern="**/*.py", path="backend") == ("allow", "default")
    assert decide("Glob", pattern="../backups/*", path="backend")[0] == "deny"
    assert decide("Grep", pattern="x", path="backend", glob="../../*")[0] == "deny"
    assert decide("Grep", pattern="..", path="backend") == ("allow", "default"), "a regex may contain dots"
    assert decide("Read", file_path="backups/dump.sql")[0] == "deny"


async def test_a_projects_claude_md_reaches_every_task_unless_private(client, csrf, platform, tmp_path):
    folder = tmp_path / "jd"
    (folder / ".claude").mkdir(parents=True)
    (folder / "CLAUDE.md").write_text("Run the tests with: npm run test:unit\n", encoding="utf-8")
    (folder / ".claude" / "CLAUDE.md").write_text("Answer in French.\n", encoding="utf-8")
    await create(client, csrf, "JD", workspace=str(folder), context="Job descriptions.")
    context = platform.projects.context("jd")
    # Like a Claude Code session in the folder: the owner's notes, then the project's own instructions.
    assert context.startswith("Job descriptions.")
    assert "## The project's CLAUDE.md" in context and "npm run test:unit" in context
    assert "Answer in French." in context

    response = await client.patch("/api/projects/jd", headers=csrf, json={"private_paths": [".claude"]})
    assert response.status_code == 200, response.text
    context = platform.projects.context("jd")
    assert "npm run test:unit" in context and "Answer in French." not in context, "a private file stays private"


async def test_watching_an_app_needs_its_compose_file_and_checked_rules(client, csrf, platform):
    project = await create(client, csrf, "Site")
    assert project["watch"] == {"on": False, "available": False}
    response = await client.patch("/api/projects/site", headers=csrf, json={"watch": {"on": True}})
    assert response.status_code == 400 and "docker-compose" in response.text, "no app to watch"

    (Path(project["workspace"]) / "docker-compose.yml").write_text("services: {}\n")
    response = await client.patch("/api/projects/site", headers=csrf, json={"watch": {"on": True}})
    assert response.status_code == 200 and response.json()["watch"] == {"on": True, "available": True}
    assert [p["id"] for p in platform.projects.watched()] == ["site"]

    for bad in (
        {"alert": ["(unclosed"]},
        {"long_task": {"start": "begin", "end": r"end (?P<id>\S+)"}},
        {"long_task": {"start": "(?P<id>a)", "end": "(?P<id>b)", "max_minutes": 1}},
        {"sound": True},
    ):
        response = await client.patch("/api/projects/site", headers=csrf, json={"watch": bad})
        assert response.status_code == 400, bad
    response = await client.patch("/api/projects/site", headers=csrf, json={"watch": {"on": False}})
    assert response.json()["watch"]["on"] is False and platform.projects.watched() == []


async def test_settings_take_the_owners_name_and_the_approval_mode(client, csrf):
    response = await client.patch(
        "/api/settings", headers=csrf, json={"owner.name": "Ada Lovelace", "permissions.mode": "auto"}
    )
    assert response.status_code == 200, response.text
    assert response.json()["values"]["permissions.mode"] == "auto"
    assert (await client.patch("/api/settings", headers=csrf, json={"permissions.mode": "all"})).status_code == 200
    for bad in ({"permissions.mode": "bypass"}, {"owner.name": "x" * 81}, {"owner.name": "two\nlines"}):
        assert (await client.patch("/api/settings", headers=csrf, json=bad)).status_code == 400, bad


def test_a_code_folder_has_the_software_engineer_as_its_direct_member(tmp_path):
    from pae.projects import direct_member

    repo, service, notes, empty = (tmp_path / n for n in ("repo", "service", "notes", "empty"))
    (repo / ".git").mkdir(parents=True)
    (service / "backend").mkdir(parents=True)
    (service / "backend" / "requirements.txt").write_text("fastapi\n")  # one folder down, like a typical web app
    notes.mkdir()
    (notes / "ideas.md").write_text("# ideas\n")
    empty.mkdir()
    assert direct_member(repo) == "software-engineering" and direct_member(service) == "software-engineering"
    assert direct_member(notes) is None and direct_member(empty) is None
    assert direct_member(tmp_path / "missing") is None
