"""Multi-agent collaboration through the runtime: dependency plans, parallel tasks, handoffs,
retries, failures, approvals inside tasks, pause, cancellation, permissions, teams, and the
execution graph rebuilt from persisted events (also after a restart).

Every task is a real child run on the scripted provider (a labelled test double for the model)."""

from __future__ import annotations

import asyncio

import pytest

from pae.api.workspace_routes import agent_names
from pae.db import Run, RunEvent
from pae.runtime.graph import build_graph
from pae.runtime.manager import SubmitError

from conftest import call, events_of, final, wait_event, wait_for

pytestmark = pytest.mark.anyio


def agent(agent_id: str, tools: list[str], **extra) -> dict:
    return {
        "id": agent_id,
        "name": agent_id.title(),
        "description": f"Test agent {agent_id}",
        "provider": "scripted",
        "instructions": "Test.",
        "tools": tools,
        **extra,
    }


@pytest.fixture
async def crew(platform):
    registry = platform.registry
    registry.save_custom(
        agent(
            "coordinator",
            ["agent_list", "agent_delegate", "agent_run_plan"],
            delegates=["*"],
            permissions={"agent_run_plan": "allow"},  # these tests are about running plans, not checking them
        ),
        create=True,
    )
    registry.save_custom(
        agent("narrow", ["agent_run_plan"], delegates=["worker-a"], permissions={"agent_run_plan": "allow"}),
        create=True,
    )
    registry.save_custom(agent("planner-checked", ["agent_run_plan"], delegates=["*"]), create=True)
    registry.save_custom(agent("worker-a", ["fs_read"]), create=True)
    registry.save_custom(agent("worker-b", ["fs_read"]), create=True)
    registry.save_custom(agent("writer", ["fs_read", "fs_write"]), create=True)
    platform.config.default_workspace.mkdir(parents=True, exist_ok=True)
    return platform


def task(task_id: str, agent_id: str, depends_on: list[str] | None = None, **extra) -> dict:
    return {
        "id": task_id,
        "agent_id": agent_id,
        "title": f"Task {task_id}",
        "task": f"Do task {task_id} and report the result.",
        "depends_on": depends_on or [],
        "reason": f"{agent_id} fits task {task_id}",
        **extra,
    }


async def run_plan(platform, tasks, scripts, *, coordinator="coordinator", project_id=None, **plan_args) -> str:
    script = [call("agent_run_plan", tasks=tasks, **plan_args), {"text": "consolidated result"}]
    return await platform.manager.submit(
        task="Reach the objective",
        agent_id=coordinator,
        options={"provider_options": {"script": script}, "tree": {"scripts": scripts}},
        project_id=project_id,
    )


def graph_of(platform, run_id: str) -> dict:
    with platform.db.session() as session:
        return build_graph(session, run_id, agent_names(platform), paused=platform.manager.is_paused(run_id))


def tasks_of(graph: dict) -> dict[str, dict]:
    return {n["task_id"]: n for n in graph["nodes"] if n["kind"] == "task"}


def edges_of(graph: dict) -> set[tuple[str, str, str]]:
    short = {n["id"]: (n.get("task_id") or n["kind"]) for n in graph["nodes"]}
    return {(e["kind"], short[e["source"]], short[e["target"]]) for e in graph["edges"]}


def children(platform, run_id: str) -> dict[str, Run]:
    with platform.db.session() as session:
        runs = session.query(Run).filter(Run.root_run_id == run_id, Run.id != run_id).order_by(Run.created_at).all()
        session.expunge_all()
    return {r.agent_id: r for r in runs}


async def wait_until(predicate, timeout: float = 10.0, interval: float = 0.02):
    deadline = asyncio.get_running_loop().time() + timeout
    while asyncio.get_running_loop().time() < deadline:
        if value := predicate():
            return value
        await asyncio.sleep(interval)
    raise AssertionError("condition not reached")


# ------------------------------------------------------------ plans


async def test_independent_tasks_run_in_parallel_and_results_are_handed_off(crew):
    scripts = {
        "worker-a": [{"delay_s": 0.4, "text": "A found 42"}],
        "worker-b": [{"delay_s": 0.4, "text": "B found 7"}],
        "helper": [{"text": "combined 49"}],
    }
    tasks = [task("a", "worker-a"), task("b", "worker-b"), task("c", "helper", ["a", "b"])]
    run_id = await run_plan(crew, tasks, scripts)
    run = await wait_for(crew, run_id)
    assert run["status"] == "completed", run["error"]

    runs = children(crew, run_id)
    a, b, c = runs["worker-a"], runs["worker-b"], runs["helper"]
    assert all(r.status == "completed" and r.parent_run_id == run_id for r in (a, b, c))
    assert max(a.started_at, b.started_at) < min(a.finished_at, b.finished_at), "a and b overlapped"
    assert c.started_at >= max(a.finished_at, b.finished_at), "c waited for its prerequisites"
    assert '<untrusted_data source="handoff:a">' in c.task and "A found 42" in c.task and "B found 7" in c.task
    assert "A found 42" not in a.task and a.role == "Task a"

    handoffs = {(e["data"]["from_task_id"], e["data"]["to_task_id"]) for e in events_of(crew, run_id, "handoff")}
    assert handoffs == {("a", "c"), ("b", "c")}
    started = {e["data"]["task_id"]: e["data"] for e in events_of(crew, run_id, "task.started")}
    assert started["c"]["child_run_id"] == c.id and started["c"]["attempt"] == 1
    done = events_of(crew, run_id, "plan.completed")[0]["data"]
    assert (done["completed"], done["failed"], done["skipped"]) == (3, 0, 0)
    tool = events_of(crew, run_id, "tool.completed")[0]["data"]
    assert tool["tool"] == "agent_run_plan" and "3 completed" in tool["output"]

    graph = graph_of(crew, run_id)
    nodes = tasks_of(graph)
    assert {k: n["status"] for k, n in nodes.items()} == {"a": "completed", "b": "completed", "c": "completed"}
    assert nodes["c"]["output_preview"] == "combined 49" and nodes["a"]["reason"] == "worker-a fits task a"
    assert nodes["c"]["input_summary"].startswith("Do task c") and "untrusted" not in nodes["c"]["input_summary"]
    edges = edges_of(graph)
    assert {("delegates", "root", "a"), ("depends_on", "a", "c"), ("handoff", "b", "c")} <= edges
    assert ("consolidates", "c", "result") in edges and ("consolidates", "a", "result") not in edges
    assert not any(e["active"] for e in graph["edges"]), "nothing is animated once the run is over"
    assert graph["status"] == "completed" and graph["agents"]["worker-a"]["name"] == "Worker-A"


async def test_parallelism_limit_is_respected(crew):
    scripts = {"worker-a": [{"delay_s": 0.3, "text": "a"}], "worker-b": [{"delay_s": 0.3, "text": "b"}]}
    run_id = await run_plan(crew, [task("a", "worker-a"), task("b", "worker-b")], scripts, max_parallel=1)
    await wait_for(crew, run_id)
    runs = sorted(children(crew, run_id).values(), key=lambda r: r.started_at)
    assert runs[0].finished_at <= runs[1].started_at, "max_parallel=1 runs one task at a time"


async def test_failed_task_is_retried_with_the_failure_in_context(crew):
    scripts = {
        "worker-a": {
            "sequence": [
                [{"error": {"message": "flaky upstream failure", "retryable": False}}],
                [{"text": "second attempt ok"}],
            ]
        }
    }
    run_id = await run_plan(crew, [task("a", "worker-a", retries=1)], scripts)
    run = await wait_for(crew, run_id)
    assert run["status"] == "completed"
    with crew.db.session() as session:
        attempts = session.query(Run).filter(Run.root_run_id == run_id, Run.agent_id == "worker-a").all()
        statuses = sorted(r.status for r in attempts)
        second = next(r for r in attempts if r.status == "completed")
        assert "## Previous attempt failed" in second.task and "flaky upstream failure" in second.task
    assert statuses == ["completed", "failed"]
    retry = events_of(crew, run_id, "task.retry")[0]["data"]
    assert retry["attempt"] == 2 and "flaky" in retry["previous_error"]
    node = tasks_of(graph_of(crew, run_id))["a"]
    assert node["status"] == "completed" and node["attempts"] == 2 and len(node["run_ids"]) == 2


async def test_failure_skips_dependents_but_independent_work_continues(crew):
    scripts = {
        "worker-a": [{"error": {"message": "cannot read the data", "retryable": False}}],
        "worker-b": [{"text": "independent ok"}],
    }
    tasks = [task("a", "worker-a"), task("dependent", "helper", ["a"]), task("b", "worker-b")]
    run_id = await run_plan(crew, tasks, scripts, stop_on_failure=False)
    run = await wait_for(crew, run_id)
    assert run["status"] == "completed", "the coordinator received the failure as a tool error and reported"
    nodes = tasks_of(graph_of(crew, run_id))
    assert nodes["a"]["status"] == "failed" and "cannot read the data" in nodes["a"]["error"]
    assert nodes["dependent"]["status"] == "skipped" and "'a' did not complete" in nodes["dependent"]["error"]
    assert nodes["b"]["status"] == "completed"
    assert "helper" not in children(crew, run_id), "a skipped task never starts a run"
    failed = events_of(crew, run_id, "tool.completed") or events_of(crew, run_id, "tool.failed")
    assert failed, "the plan outcome reached the coordinator"


async def test_stop_on_failure_skips_the_rest_of_the_plan(crew):
    scripts = {"worker-a": [{"error": {"message": "boom", "retryable": False}}], "worker-b": [{"text": "never"}]}
    run_id = await run_plan(crew, [task("a", "worker-a"), task("b", "worker-b")], scripts, max_parallel=1)
    await wait_for(crew, run_id)
    nodes = tasks_of(graph_of(crew, run_id))
    assert nodes["a"]["status"] == "failed" and nodes["b"]["status"] == "skipped"
    assert "stopped after a failure" in nodes["b"]["error"]


# ------------------------------------------------------------ permissions and validation


async def test_plan_outside_the_delegation_allowlist_is_refused(crew):
    run_id = await run_plan(crew, [task("a", "worker-a"), task("b", "worker-b")], {}, coordinator="narrow")
    await wait_for(crew, run_id)
    error = events_of(crew, run_id, "tool.failed")[0]["data"]["error"]
    assert "'worker-b' is not allowed" in error
    assert not children(crew, run_id) and not events_of(crew, run_id, "plan.created")


@pytest.mark.parametrize(
    ("tasks", "message"),
    [
        ([task("a", "worker-a", ["b"]), task("b", "worker-b", ["a"])], "cycle"),
        ([task("a", "worker-a", ["missing"])], "unknown task"),
        ([task("a", "worker-a"), task("a", "worker-b")], "unique"),
        ([task("a", "coordinator")], "cannot delegate to itself"),
    ],
)
async def test_invalid_plans_are_refused_before_anything_runs(crew, tasks, message):
    run_id = await run_plan(crew, tasks, {})
    await wait_for(crew, run_id)
    assert message in events_of(crew, run_id, "tool.failed")[0]["data"]["error"]
    assert not children(crew, run_id)


async def test_agent_list_exposes_responsibilities_and_boundaries(crew):
    script = [call("agent_list"), {"text": "listed"}]
    run_id = await crew.manager.submit(
        task="who can help", agent_id="coordinator", options={"provider_options": {"script": script}}
    )
    await wait_for(crew, run_id)
    event = events_of(crew, run_id, "tool.completed")[0]["data"]
    output, listed = event["output"], event["data"]["agents"]  # the stored output is cut at 8000 characters
    assert '"boundaries"' in output and '"responsibility"' in output
    assert "research" in listed and "architecture" in listed and "deployment" in listed
    assert "coordinator" not in listed, "an agent is not offered itself"


# ------------------------------------------------------------ approvals, pause, cancellation


async def test_approval_inside_a_task_is_shown_on_the_task_and_resolved(crew):
    scripts = {"writer": [call("fs_write", path="out.txt", content="hello"), {"text": "written"}]}
    run_id = await run_plan(crew, [task("w", "writer")], scripts)
    requested = await wait_event(crew, run_id, "approval.requested")

    graph = await wait_until(
        lambda: (g := graph_of(crew, run_id)) and tasks_of(g).get("w", {}).get("status") == "waiting_approval" and g
    )
    node = tasks_of(graph)["w"]
    approval = next(n for n in graph["nodes"] if n["kind"] == "approval")
    assert approval["attached_to"] == node["id"] and approval["status"] == "pending" and approval["tool"] == "fs_write"
    assert node["pending_approvals"] == 1
    active = {e["kind"] for e in graph["edges"] if e["active"]}
    assert {"approval", "delegates"} <= active

    await crew.manager.approvals.decide(requested["data"]["approval_id"], True, "fine", "owner")
    assert (await wait_for(crew, run_id))["status"] == "completed"
    graph = graph_of(crew, run_id)
    assert next(n for n in graph["nodes"] if n["kind"] == "approval")["status"] == "approved"
    assert tasks_of(graph)["w"]["status"] == "completed"
    assert (crew.config.default_workspace / "out.txt").read_text() == "hello"


async def test_pause_holds_new_tasks_until_unpaused(crew):
    scripts = {"worker-a": [{"delay_s": 0.4, "text": "first"}], "worker-b": [{"text": "second"}]}
    run_id = await run_plan(crew, [task("a", "worker-a"), task("b", "worker-b", ["a"])], scripts)
    await wait_event(crew, run_id, "task.started")
    assert await crew.manager.pause(run_id) is True
    await wait_until(lambda: [e for e in events_of(crew, run_id, "task.completed") if e["data"]["task_id"] == "a"])
    await asyncio.sleep(0.3)
    started = {e["data"]["task_id"] for e in events_of(crew, run_id, "task.started")}
    assert started == {"a"}, "no new task starts while paused; the running one finished"
    graph = graph_of(crew, run_id)
    assert graph["paused"] is True and tasks_of(graph)["b"]["status"] == "pending"

    await crew.manager.unpause(run_id)
    assert (await wait_for(crew, run_id))["status"] == "completed"
    assert tasks_of(graph_of(crew, run_id))["b"]["status"] == "completed"
    paused, unpaused = events_of(crew, run_id, "run.paused"), events_of(crew, run_id, "run.unpaused")
    assert len(paused) == 1 and len(unpaused) == 1 and paused[0]["source"] == "user"
    assert not crew.manager.is_paused(run_id)


async def test_pause_is_refused_for_children_and_finished_runs(crew):
    scripts = {"worker-a": [{"delay_s": 0.5, "text": "slow"}]}
    run_id = await run_plan(crew, [task("a", "worker-a")], scripts)
    started = await wait_event(crew, run_id, "task.started")
    with pytest.raises(SubmitError, match="root run"):
        await crew.manager.pause(started["data"]["child_run_id"])
    await wait_for(crew, run_id)
    with pytest.raises(SubmitError, match="completed"):
        await crew.manager.pause(run_id)


async def test_cancelling_the_root_cancels_running_tasks(crew):
    scripts = {"worker-a": [{"delay_s": 10, "text": "slow"}], "worker-b": [{"delay_s": 10, "text": "slow"}]}
    run_id = await run_plan(crew, [task("a", "worker-a"), task("b", "worker-b"), task("c", "helper", ["a"])], scripts)
    await wait_until(lambda: len(events_of(crew, run_id, "task.started")) == 2)
    await crew.manager.cancel(run_id)
    assert (await wait_for(crew, run_id))["status"] == "cancelled"
    assert {r.status for r in children(crew, run_id).values()} == {"cancelled"}
    nodes = tasks_of(graph_of(crew, run_id))
    assert nodes["a"]["status"] == nodes["b"]["status"] == "cancelled"
    assert nodes["c"]["status"] == "cancelled", "a task that never started is shown as cancelled, not pending"


# ------------------------------------------------------------ delegation, teams, reconstruction


async def test_single_delegation_is_a_one_task_plan(crew):
    script = [call("agent_delegate", agent_id="worker-a", task="read the notes and report"), {"text": "done"}]
    run_id = await crew.manager.submit(
        task="delegate once",
        agent_id="coordinator",
        options={"provider_options": {"script": script}, "tree": {"scripts": {"worker-a": [{"text": "notes ok"}]}}},
    )
    await wait_for(crew, run_id)
    graph = graph_of(crew, run_id)
    nodes = tasks_of(graph)
    assert list(nodes) == ["t1"] and nodes["t1"]["agent_id"] == "worker-a" and nodes["t1"]["status"] == "completed"
    assert {("delegates", "root", "t1"), ("consolidates", "t1", "result")} <= edges_of(graph)
    assert events_of(crew, run_id, "delegation.completed")[0]["data"]["status"] == "completed"


async def test_sequential_team_is_a_dependency_chain_with_handoffs(crew):
    scripts = {"helper": [{"text": "step output"}], "tester": [final("final from tester")]}
    run_id = await crew.manager.submit(
        task="team task",
        team={"mode": "sequential", "members": [{"agent": "helper"}, {"agent": "tester"}]},
        provider="scripted",
        options={"tree": {"scripts": scripts}},
    )
    assert (await wait_for(crew, run_id))["status"] == "completed"
    graph = graph_of(crew, run_id)
    assert {("depends_on", "m1", "m2"), ("handoff", "m1", "m2"), ("consolidates", "m2", "result")} <= edges_of(graph)
    assert graph["nodes"][0]["kind"] == "root"


async def test_orchestrated_team_shows_the_nested_plan_under_the_orchestrator(crew):
    scripts = {
        "coordinator": [
            call("agent_run_plan", tasks=[task("x", "worker-a"), task("y", "worker-b", ["x"])]),
            {"text": "team consolidated"},
        ],
        "worker-a": [{"text": "x done"}],
        "worker-b": [{"text": "y done"}],
    }
    run_id = await crew.manager.submit(
        task="orchestrated objective",
        team={
            "mode": "orchestrated",
            "orchestrator": "coordinator",
            "members": [
                {"agent": "worker-a", "responsibility": "first"},
                {"agent": "worker-b", "responsibility": "then"},
            ],
        },
        provider="scripted",
        options={"tree": {"scripts": scripts}},
    )
    run = await wait_for(crew, run_id)
    assert run["status"] == "completed", run["error"]
    graph = graph_of(crew, run_id)
    nodes = tasks_of(graph)
    coordinate = nodes["coordinate"]
    assert coordinate["agent_id"] == "coordinator" and coordinate["parent_id"] == f"run:{run_id}"
    assert nodes["x"]["parent_id"] == coordinate["id"] and nodes["y"]["parent_id"] == coordinate["id"]
    assert {("delegates", "coordinate", "x"), ("handoff", "x", "y")} <= edges_of(graph)
    assert ("consolidates", "coordinate", "result") in edges_of(graph)


async def test_orchestrator_in_a_team_cannot_delegate_outside_the_team(crew):
    scripts = {"coordinator": [call("agent_run_plan", tasks=[task("z", "writer")]), {"text": "tried"}]}
    run_id = await crew.manager.submit(
        task="orchestrated objective",
        team={"mode": "orchestrated", "orchestrator": "coordinator", "members": [{"agent": "worker-a"}]},
        provider="scripted",
        options={"tree": {"scripts": scripts}},
    )
    await wait_for(crew, run_id)
    errors = [e["data"]["error"] for e in events_of(crew, run_id, "tool.failed")]
    assert any("'writer' is not allowed" in e for e in errors)
    assert "writer" not in children(crew, run_id)


async def test_graph_is_rebuilt_identically_after_a_restart(crew, config):
    from pae.platform import Platform

    scripts = {"worker-a": [{"text": "a"}], "worker-b": [{"text": "b"}]}
    run_id = await run_plan(crew, [task("a", "worker-a"), task("b", "worker-b", ["a"])], scripts)
    await wait_for(crew, run_id)
    before = graph_of(crew, run_id)
    await crew.stop()

    restarted = Platform(config)
    await restarted.start()
    try:
        after = graph_of(restarted, run_id)
    finally:
        await restarted.stop()
    assert after == before
    assert len(tasks_of(after)) == 2 and after["last_event_id"] > 0


def lose_task_event(platform, run_id: str, type_: str, task_id: str) -> None:
    """What an interrupted plan leaves behind: a step that started and never got its last event."""
    with platform.db.session() as session:
        for event in session.query(RunEvent).filter(RunEvent.root_run_id == run_id, RunEvent.type == type_):
            if (event.data or {}).get("task_id") == task_id:
                session.delete(event)


async def test_a_finished_task_shows_no_step_at_work(crew):
    from pae.api.workspace_routes import executions

    scripts = {
        "worker-b": [{"text": "B found 7"}],
        "worker-a": [{"error": {"message": "the disk is full", "retryable": False}}],
    }
    run_id = await run_plan(crew, [task("b", "worker-b"), task("a", "worker-a", ["b"])], scripts)
    run = await wait_for(crew, run_id)
    assert run["status"] == "completed", run["error"]
    lose_task_event(crew, run_id, "task.completed", "b")
    lose_task_event(crew, run_id, "task.failed", "a")

    graph = graph_of(crew, run_id)
    nodes = tasks_of(graph)
    # Each step's own run says how it ended.
    assert nodes["b"]["status"] == "completed" and "B found 7" in nodes["b"]["output_preview"]
    assert nodes["a"]["status"] == "failed" and "the disk is full" in nodes["a"]["error"]
    assert nodes["a"]["finished_at"] and not any(e["active"] for e in graph["edges"])

    class Request:
        class app:
            class state:
                platform = crew

    items = executions(Request(), identity={"actor": "owner"}, project_id=None, status=None, limit=50)["items"]
    assert next(i for i in items if i["run_id"] == run_id)["tasks"]["running"] == 0


async def test_a_step_left_by_an_interrupted_plan_is_not_at_work_when_the_task_goes_on(crew):
    scripts = {"worker-a": [{"text": "A found 42"}]}
    run_id = await run_plan(crew, [task("a", "worker-a")], scripts)
    await wait_for(crew, run_id)
    lose_task_event(crew, run_id, "task.completed", "a")
    # The run that made the plan was interrupted, then taken up again: the task is at work.
    with crew.db.session() as session:
        ended = session.query(RunEvent).filter(RunEvent.run_id == run_id, RunEvent.type == "run.completed").one()
        ended.type = "run.interrupted"
        session.get(Run, run_id).status = "running"

    graph = graph_of(crew, run_id)
    assert graph["status"] == "running"
    assert tasks_of(graph)["a"]["status"] == "completed"
    assert not any(e["active"] for e in graph["edges"])


async def test_a_step_at_work_shows_at_work(crew):
    scripts = {"worker-a": [{"delay_s": 0.6, "text": "A found 42"}]}
    run_id = await run_plan(crew, [task("a", "worker-a")], scripts)
    graph = await wait_until(
        lambda: (g := graph_of(crew, run_id)) and tasks_of(g).get("a", {}).get("status") == "running" and g
    )
    assert ("delegates", "root", "a") in {(k, s, t) for k, s, t in edges_of(graph)}
    assert any(e["active"] for e in graph["edges"])
    await wait_for(crew, run_id)
    assert tasks_of(graph_of(crew, run_id))["a"]["status"] == "completed"


async def test_handoff_label_uses_the_agents_own_summary(crew):
    scripts = {
        "tester": [final("structured", count=2)],
        "worker-a": [{"text": "plain text result"}],
        "helper": [{"text": "used both"}],
    }
    tasks = [task("s", "tester"), task("p", "worker-a"), task("h", "helper", ["s", "p"])]
    # tester's schema has no summary: the preview is used; plain text: the text itself.
    run_id = await run_plan(crew, tasks, scripts)
    await wait_for(crew, run_id)
    labels = {e["data"]["from_task_id"]: e["data"]["summary"] for e in events_of(crew, run_id, "handoff")}
    assert labels["p"] == "plain text result" and '"answer": "structured"' in labels["s"]

    from pae.runtime.plans import handoff_summary

    envelope = {"output": {"status": "partial", "summary": "2 of 3 sources read", "issues": ["one 404"]}}
    assert handoff_summary(envelope) == "[partial] 2 of 3 sources read"


async def test_execution_counts_each_task_once_across_retries(crew):
    from pae.api.workspace_routes import executions

    scripts = {"worker-a": {"sequence": [[{"error": {"message": "flaky", "retryable": False}}], [{"text": "ok"}]]}}
    run_id = await run_plan(crew, [task("a", "worker-a", retries=1), task("b", "worker-b", ["a"])], scripts)
    await wait_for(crew, run_id)

    class Request:
        class app:
            class state:
                platform = crew

    items = executions(Request(), identity={"actor": "owner"}, project_id=None, status=None, limit=50)["items"]
    counts = next(i for i in items if i["run_id"] == run_id)["tasks"]
    assert counts == {"total": 2, "completed": 2, "failed": 0, "skipped": 0, "running": 0}


def test_step_names_end_on_a_whole_word():
    from pae.runtime.plans import PlanTask

    long_task = (
        "Explain, in simple plain words for a beginner, what a good README file should contain and why it matters"
    )
    label = PlanTask(id="t1", agent_id="documentation", task=long_task).label()
    assert label == "Explain, in simple plain words for a beginner, what a good README file should..."
    assert (
        PlanTask(id="t1", agent_id="x", task=long_task, title="Write the README guide").label()
        == "Write the README guide"
    )
    assert PlanTask(id="t1", agent_id="x", task="Short task here").label() == "Short task here"


async def test_single_delegation_keeps_the_title_it_was_given(crew):
    script = [
        call(
            "agent_delegate",
            agent_id="worker-a",
            task="Read the notes and report what they say.",
            title="Read the notes",
        ),
        {"text": "done"},
    ]
    run_id = await crew.manager.submit(
        task="delegate with a title",
        agent_id="coordinator",
        options={"provider_options": {"script": script}, "tree": {"scripts": {"worker-a": [{"text": "ok"}]}}},
    )
    await wait_for(crew, run_id)
    assert tasks_of(graph_of(crew, run_id))["t1"]["title"] == "Read the notes"


async def test_the_owner_checks_a_plan_before_any_work_starts(crew):
    plan = [task("a", "worker-a"), task("b", "worker-b", ["a"])]
    script = [
        call("agent_run_plan", tasks=plan),
        call("agent_run_plan", tasks=plan[:1]),
        {"text": "done"},
    ]
    scripts = {"worker-a": [{"text": "a done"}], "worker-b": [{"text": "b done"}]}
    run_id = await crew.manager.submit(
        task="checked plan",
        agent_id="planner-checked",
        options={"provider_options": {"script": script}, "tree": {"scripts": scripts}},
    )
    first = await wait_event(crew, run_id, "approval.requested")
    assert first["data"]["tool"] == "agent_run_plan" and len(first["data"]["args"]["tasks"]) == 2
    assert not children(crew, run_id), "nothing starts before the owner decides"
    await crew.manager.approvals.decide(first["data"]["approval_id"], False, "Only task a, please", "owner")

    second = await wait_until(lambda: [e for e in events_of(crew, run_id, "approval.requested")][1:] or None)
    with crew.db.session() as session:
        messages = str(session.get(Run, run_id).checkpoint["messages"])
    assert "Only task a, please" in messages, "the owner's note reaches the Coordinator"
    await crew.manager.approvals.decide(second[0]["data"]["approval_id"], True, None, "owner")
    assert (await wait_for(crew, run_id))["status"] == "completed"
    assert set(children(crew, run_id)) == {"worker-a"}
