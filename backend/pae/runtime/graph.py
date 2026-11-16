"""Execution graph of a run tree, rebuilt from persisted runs, events and approvals.

The graph is derived only from what the runtime recorded, so it is the same live
and after a refresh or a restart, and it never shows activity that did not happen.

Nodes: the root run, one node per planned task (with its attempts' child runs),
approval gates attached to the task (or root) whose run requested them, and the
final result. Edges: delegates (planner -> task), depends_on (prerequisite -> task),
handoff (a result actually passed from one task to another), approval, consolidates.
An edge is `active` only while its target is running or waiting for approval.
"""

from __future__ import annotations

import json
from collections import Counter

from pae.db import Approval, Run, RunEvent

TERMINAL_TASK = {"completed", "failed", "skipped", "cancelled"}
#: A task that has ended, whatever the way: nothing in it is still at work.
ROOT_OVER = {"completed", "failed", "cancelled", "interrupted"}
LIVE_TASK = {"running", "retrying", "waiting_approval"}
#: A run's last word. A plan runs inside the run that made it, so once that run has
#: ended, none of the plan's steps is still at work, even if the run starts again later.
RUN_ENDED = {"run.completed", "run.failed", "run.cancelled", "run.interrupted"}


def _iso(value) -> str | None:
    return value.isoformat() if value else None


def _usage(run: Run | None) -> dict:
    if run is None:
        return {"input_tokens": 0, "output_tokens": 0, "cost_usd": 0.0, "duration_s": None, "steps": 0, "tool_calls": 0}
    duration = None
    if run.started_at and run.finished_at:
        duration = round((run.finished_at - run.started_at).total_seconds(), 2)
    return {
        "input_tokens": run.input_tokens,
        "output_tokens": run.output_tokens,
        "cost_usd": run.cost_usd,
        "duration_s": duration,
        "steps": run.steps,
        "tool_calls": run.tool_calls,
    }


def _preview(run: Run | None, limit: int = 600) -> str | None:
    if run is None:
        return None
    body = run.output if run.output is not None else run.output_text
    if body is None:
        return None
    text = body if isinstance(body, str) else json.dumps(body, ensure_ascii=False, default=str)
    return text if len(text) <= limit else text[:limit] + "..."


def build_graph(session, root_run_id: str, agents: dict[str, dict], paused: bool = False) -> dict:
    root = session.get(Run, root_run_id)
    if root is None:
        raise KeyError(root_run_id)
    runs = {r.id: r for r in session.query(Run).filter(Run.root_run_id == root_run_id)}
    events = session.query(RunEvent).filter(RunEvent.root_run_id == root_run_id).order_by(RunEvent.id).all()
    approvals = session.query(Approval).filter(Approval.root_run_id == root_run_id).order_by(Approval.created_at).all()

    root_id = f"run:{root.id}"
    nodes: dict[str, dict] = {}
    edges: dict[str, dict] = {}
    run_to_node: dict[str, str] = {root.id: root_id}
    tools_by_run: dict[str, Counter] = {}

    nodes[root_id] = {
        "id": root_id,
        "kind": "root",
        "run_id": root.id,
        "agent_id": root.agent_id,
        "team_id": root.team_id,
        "label": (root.options or {}).get("team", {}).get("name")
        if root.kind == "team"
        else agents.get(root.agent_id or "", {}).get("name", root.agent_id),
        "status": root.status,
        "started_at": _iso(root.started_at),
        "finished_at": _iso(root.finished_at),
        "usage": _usage(root),
        "error": root.error,
    }

    def add_edge(source: str, target: str, kind: str, label: str | None = None) -> None:
        edge_id = f"{kind}:{source}->{target}"
        edges.setdefault(
            edge_id,
            {
                "id": edge_id,
                "source": source,
                "target": target,
                "kind": kind,
                "active": False,
                **({"label": label} if label else {}),
            },
        )

    # Steps left at work by a run that ended without closing them (interrupted plan).
    orphaned: set[str] = set()

    for event in events:
        data = event.data or {}
        if event.type == "tool.completed" or event.type == "tool.failed":
            tools_by_run.setdefault(event.run_id, Counter())[data.get("tool", "?")] += 1
        if event.type in RUN_ENDED:
            owner = run_to_node.get(event.run_id)
            orphaned.update(
                n["id"]
                for n in nodes.values()
                if n["kind"] == "task" and n["parent_id"] == owner and n["status"] in LIVE_TASK
            )
            continue
        if event.type == "plan.created":
            parent_node = run_to_node.get(data.get("created_by_run_id") or event.run_id, root_id)
            plan_id = data["plan_id"]
            for task in data.get("tasks", []):
                node_id = f"task:{plan_id}:{task['id']}"
                previous = nodes.get(node_id, {})
                nodes[node_id] = {
                    "id": node_id,
                    "kind": "task",
                    "plan_id": plan_id,
                    "task_id": task["id"],
                    "parent_id": parent_node,
                    "agent_id": task["agent_id"],
                    "title": task.get("title", ""),
                    "reason": task.get("reason", ""),
                    "depends_on": [
                        f"task:{plan_id}:{d}" for d in [*task.get("depends_on", []), *task.get("after", [])]
                    ],
                    "status": previous.get("status", "pending"),
                    "attempts": previous.get("attempts", 0),
                    "run_ids": previous.get("run_ids", []),
                    "current_run_id": previous.get("current_run_id"),
                    "input_summary": "",
                    "output_preview": previous.get("output_preview"),
                    "error": previous.get("error"),
                    "started_at": previous.get("started_at"),
                    "finished_at": previous.get("finished_at"),
                }
                add_edge(parent_node, node_id, "delegates", "assigned")
                for dep in nodes[node_id]["depends_on"]:
                    add_edge(dep, node_id, "depends_on")
            continue
        plan_id, task_id = data.get("plan_id"), data.get("task_id")
        node = nodes.get(f"task:{plan_id}:{task_id}") if plan_id and task_id else None
        if node and event.type.startswith("task."):
            orphaned.discard(node["id"])  # the step has news again: its plan was taken up
        if event.type == "task.started" and node:
            node["status"] = "running"
            node["attempts"] = max(node["attempts"], int(data.get("attempt") or 1))
            child = data.get("child_run_id")
            if child:
                node["run_ids"].append(child)
                node["current_run_id"] = child
                run_to_node[child] = node["id"]
            node["started_at"] = node["started_at"] or event.ts.isoformat()
        elif event.type == "task.retry" and node:
            node["status"] = "retrying"
            node["error"] = data.get("previous_error")
        elif event.type in ("task.completed", "task.failed", "task.skipped") and node:
            node["status"] = event.type.split(".")[1]
            if event.type == "task.failed" and data.get("status") == "cancelled":
                node["status"] = "cancelled"
            node["error"] = data.get("error") or data.get("reason") if event.type != "task.completed" else None
            node["finished_at"] = event.ts.isoformat()
            if data.get("child_run_id") and data["child_run_id"] not in node["run_ids"]:
                node["run_ids"].append(data["child_run_id"])
                node["current_run_id"] = data["child_run_id"]
                run_to_node[data["child_run_id"]] = node["id"]
        elif event.type == "handoff":
            source = nodes.get(f"task:{plan_id}:{data.get('from_task_id')}")
            target = nodes.get(f"task:{plan_id}:{data.get('to_task_id')}")
            if source and target:
                add_edge(source["id"], target["id"], "handoff", (data.get("summary") or "")[:160])

    # Live state and per-task details come from the runs themselves.
    over = root.status in ROOT_OVER
    for node in nodes.values():
        if node["kind"] != "task":
            continue
        run = runs.get(node["current_run_id"] or "")
        if run is not None:
            if node["status"] in ("running", "retrying") and run.status == "waiting_approval":
                node["status"] = "waiting_approval"
            stale = node["status"] in LIVE_TASK and (over or node["id"] in orphaned)
            if stale or (over and node["status"] == "pending"):
                # The step's last event is missing (its plan was interrupted, the server
                # stopped): its run says how it ended.
                node["status"] = run.status if run.status in ("completed", "failed") else "cancelled"
                if node["status"] == "failed":
                    node["error"] = run.error or node["error"]
                node["finished_at"] = node["finished_at"] or _iso(run.finished_at)
            node["output_preview"] = _preview(run) if node["status"] == "completed" else node["output_preview"]
            node["input_summary"] = run.task.split("\n\n## Results handed off")[0][:600]
        elif over and node["status"] == "pending":
            node["status"] = "skipped" if root.status == "completed" else "cancelled"
        elif node["status"] in LIVE_TASK and (over or node["id"] in orphaned):
            node["status"] = "cancelled"
        usage = [_usage(runs.get(rid)) for rid in node["run_ids"]]
        node["usage"] = {
            "input_tokens": sum(u["input_tokens"] for u in usage),
            "output_tokens": sum(u["output_tokens"] for u in usage),
            "cost_usd": round(sum(u["cost_usd"] for u in usage), 6),
            "duration_s": round(sum(u["duration_s"] or 0 for u in usage), 2) if usage else None,
            "steps": sum(u["steps"] for u in usage),
            "tool_calls": sum(u["tool_calls"] for u in usage),
        }
        tools = Counter()
        for rid in node["run_ids"]:
            tools.update(tools_by_run.get(rid, {}))
        node["tools_used"] = dict(tools)
        node["pending_approvals"] = 0

    # Approval gates, attached to the task (or root) whose run asked.
    for approval in approvals:
        attached = run_to_node.get(approval.run_id, root_id)
        node_id = f"approval:{approval.id}"
        nodes[node_id] = {
            "id": node_id,
            "kind": "approval",
            "approval_id": approval.id,
            "run_id": approval.run_id,
            "attached_to": attached,
            "tool": approval.tool,
            "risk": approval.risk,
            "status": approval.status,
            "reason": approval.reason,
            "args": approval.args,
        }
        add_edge(attached, node_id, "approval", approval.tool)
        if approval.status == "pending" and nodes[attached]["kind"] == "task":
            nodes[attached]["pending_approvals"] += 1

    # Final result, fed by the root and by the top-level tasks nobody else depends on.
    result_id = f"result:{root.id}"
    result_status = {
        "completed": "completed",
        "failed": "failed",
        "cancelled": "cancelled",
        "interrupted": "failed",
    }.get(root.status, "pending")
    nodes[result_id] = {
        "id": result_id,
        "kind": "result",
        "status": result_status,
        "output_preview": _preview(root) if root.status == "completed" else root.error,
    }
    top_tasks = [n for n in nodes.values() if n["kind"] == "task" and n["parent_id"] == root_id]
    depended = {dep for n in top_tasks for dep in n["depends_on"]}
    for node in top_tasks:
        if node["id"] not in depended:
            add_edge(node["id"], result_id, "consolidates")
    if not top_tasks:
        add_edge(root_id, result_id, "consolidates")

    for edge in edges.values():
        target = nodes.get(edge["target"], {})
        edge["active"] = target.get("status") in LIVE_TASK or (
            target.get("kind") == "approval" and target.get("status") == "pending"
        )

    used_agents = {n.get("agent_id") for n in nodes.values() if n.get("agent_id")}
    return {
        "root_run_id": root.id,
        "project_id": root.project_id,
        "status": root.status,
        "paused": paused,
        "title": root.task,
        "last_event_id": events[-1].id if events else 0,
        "agents": {a: agents.get(a, {"name": a, "responsibility": ""}) for a in used_agents},
        "nodes": list(nodes.values()),
        "edges": list(edges.values()),
    }
