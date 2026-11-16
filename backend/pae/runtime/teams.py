"""Teams: sequential, parallel and orchestrated collaboration, expressed as plans.

Every mode runs through the plan executor, so a team produces the same events and
execution graph as an Orchestrator plan:
- sequential: each member depends on the previous one and receives the earlier results;
- parallel: members run at the same time; an optional consolidator depends on all of them;
- orchestrated: one task for the orchestrator, which plans and delegates to the members.
"""

from __future__ import annotations

import json

from pae.runtime.context import Outcome, RunContext, RunFailure
from pae.runtime.plans import PlanTask, execute_plan


def _render(result: dict) -> str:
    body = result.get("output")
    if body is not None:
        return json.dumps(body, indent=1, ensure_ascii=False, default=str)
    return result.get("output_text") or "(no output)"


def build_tasks(ctx: RunContext, spec: dict) -> list[PlanTask]:
    mode, members = spec["mode"], spec["members"]
    stop_on_failure = spec.get("on_failure", "stop") == "stop"
    tasks: list[PlanTask] = []
    if mode == "orchestrated":
        roster = "\n".join(f"- `{m['agent']}`: {m.get('responsibility') or 'see agent_list'}" for m in members)
        return [
            PlanTask(
                id="coordinate",
                agent_id=spec.get("orchestrator") or "orchestrator",
                title="Coordinate the team",
                task=f"{ctx.task}\n\n## Your team\nDelegate only to these agents:\n{roster}",
                reason="Team mode: orchestrated",
                role="Coordinate the team",
                delegates=[m["agent"] for m in members],
            )
        ]
    for index, member in enumerate(members):
        responsibility = member.get("responsibility") or ""
        tasks.append(
            PlanTask(
                id=f"m{index + 1}",
                agent_id=member["agent"],
                title=responsibility[:120] or f"{member['agent']} contribution",
                task=ctx.task,
                # Sequential: each member works after the previous one and receives its result. With
                # on_failure=continue the order is kept but a failed member does not skip the next one.
                depends_on=[f"m{index}"] if mode == "sequential" and index and stop_on_failure else [],
                after=[f"m{index}"] if mode == "sequential" and index and not stop_on_failure else [],
                reason=f"Team member: {responsibility}" if responsibility else "Team member",
                role=responsibility or None,
            )
        )
    if mode == "parallel" and spec.get("consolidator"):
        tasks.append(
            PlanTask(
                id="consolidate",
                agent_id=spec["consolidator"],
                title="Consolidate the team's results",
                task=f"{ctx.task}\n\nConsolidate the team's contributions handed off below into one result. "
                "Resolve conflicts explicitly and keep references.",
                depends_on=[t.id for t in tasks],
                reason="Team consolidator",
                role="Consolidate the team's results",
            )
        )
    return tasks


async def run_team(ctx: RunContext, spec: dict) -> Outcome:
    """`spec`: {mode, members: [{agent, responsibility}], orchestrator?, consolidator?, on_failure?}"""
    mode = spec["mode"]
    if mode not in ("sequential", "parallel", "orchestrated"):
        raise RunFailure(f"unknown team mode '{mode}'")
    stop = spec.get("on_failure", "stop") == "stop"
    tasks = build_tasks(ctx, spec)
    done = dict((ctx.checkpoint or {}).get("plan_results", {}))

    def save(task_id: str, result: dict) -> None:
        done[task_id] = result
        ctx.save_checkpoint([], plan_results=done)

    outcome = await execute_plan(
        ctx,
        tasks,
        plan_id=f"team-{ctx.run_id[:8]}",
        stop_on_failure=stop,
        completed=done,
        on_result=save,
    )
    results = outcome["results"]
    contributions = [
        {
            "agent": t.agent_id,
            "responsibility": t.role or "",
            "task_id": t.id,
            "run_id": results[t.id].get("run_id"),
            "status": results[t.id]["status"],
            "output": results[t.id].get("output"),
            "output_text": results[t.id].get("output_text"),
            "error": results[t.id].get("error"),
        }
        for t in tasks
    ]
    failed = [c for c in contributions if c["status"] not in ("completed", "skipped")]
    if failed and stop:
        first = failed[0]
        raise RunFailure(f"team member '{first['agent']}' ended with status {first['status']}", code="member_failed")
    if mode == "parallel" and spec.get("consolidator"):
        final = contributions[-1]
        if final["status"] != "completed":
            raise RunFailure("the consolidator did not complete", code="member_failed")
        return Outcome(
            output={"mode": mode, "contributions": contributions, "result": final["output"]},
            output_text=final["output_text"],
        )
    if mode == "parallel":
        text = "\n\n".join(f"## {c['agent']}\n{_render(c)}" for c in contributions)
        return Outcome(output={"mode": mode, "contributions": contributions, "result": None}, output_text=text)
    last = next((c for c in reversed(contributions) if c["status"] == "completed"), contributions[-1])
    return Outcome(
        output={"mode": mode, "contributions": contributions, "result": last["output"]}, output_text=last["output_text"]
    )
