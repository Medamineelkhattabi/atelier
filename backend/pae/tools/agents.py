"""Collaboration tools: discover agents, delegate one task, or run a dependency plan.

All three go through the platform runtime: every delegated task is a real child run
of the assigned agent, with its own permissions, approvals, limits and events.
"""

from __future__ import annotations

import json

from pydantic import Field

from pae.tools.base import Args, Tool, ToolContext, ToolError, ToolResult, truncate


class NoArgs(Args):
    pass


def _allowed(ctx: ToolContext) -> list[str]:
    return list(ctx.agent.delegates) if ctx.agent else []


def _check_allowed(ctx: ToolContext, agent_id: str) -> None:
    allowed = _allowed(ctx)
    if agent_id == ctx.agent_id:
        raise ToolError("an agent cannot delegate to itself")
    if "*" not in allowed and agent_id not in allowed:
        raise ToolError(f"delegation to '{agent_id}' is not allowed; allowed: {', '.join(allowed) or 'none'}")


async def agent_list(_args: NoArgs, ctx: ToolContext) -> ToolResult:
    allowed = _allowed(ctx)
    agents = []
    for definition, meta in ctx.manager.registry.list():
        if definition.id == ctx.agent_id or not meta["enabled"] or meta["problems"]:
            continue
        if "*" in allowed or definition.id in allowed:
            agents.append(
                {
                    "id": definition.id,
                    "name": definition.name,
                    "responsibility": definition.responsibility or definition.description,
                    "capabilities": definition.capabilities,
                    "boundaries": definition.boundaries,
                    "needs": definition.input_hint,
                    "works_with": definition.works_with,
                    "writes_or_acts": any(
                        (t := ctx.manager.tools.get(name)) and t.risk != "read" for name in definition.tools
                    )
                    or bool(set(definition.claude_code_tools) & {"Edit", "Write", "Bash"}),
                }
            )
    return ToolResult(json.dumps(agents, indent=1), {"agents": [a["id"] for a in agents]})


def _render(result: dict) -> str:
    body = result["output"] if result.get("output") is not None else result.get("output_text")
    text = body if isinstance(body, str) else json.dumps(body, indent=1, ensure_ascii=False, default=str)
    return text or "(none)"


class DelegateArgs(Args):
    agent_id: str = Field(description="Id of the agent to delegate to (see agent_list)")
    task: str = Field(min_length=10, description="Self-contained task: the agent sees nothing else")
    title: str = Field("", max_length=120, description="A few words the owner reads, e.g. 'Write the README guide'")
    reason: str = Field("", description="Why this agent is the right one (shown to the owner)")
    input: dict | None = Field(None, description="Optional structured input for the agent")


async def agent_delegate(args: DelegateArgs, ctx: ToolContext) -> ToolResult:
    from pae.runtime.plans import PlanError, PlanTask, execute_plan

    _check_allowed(ctx, args.agent_id)
    parent = ctx.manager.context_of(ctx.run_id)
    task = PlanTask(
        id="t1", agent_id=args.agent_id, task=args.task, title=args.title.strip(), reason=args.reason, input=args.input
    )
    try:
        outcome = await execute_plan(parent, [task])
    except PlanError as exc:
        raise ToolError(str(exc)) from exc
    result = outcome["results"]["t1"]
    content = (
        f"Delegated run {result.get('run_id')} ({args.agent_id}) ended with status '{result['status']}'.\n"
        + (f"Error: {result['error']}\n" if result.get("error") else "")
        + f"Output:\n{truncate(_render(result), 60_000)}"
    )
    return ToolResult(
        content,
        {"child_run_id": result.get("run_id"), "status": result["status"], "plan_id": outcome["plan_id"]},
        is_error=result["status"] != "completed",
    )


class PlanTaskArgs(Args):
    id: str = Field(pattern=r"^[A-Za-z0-9_-]{1,40}$", description="Short unique id, e.g. 'research'")
    agent_id: str = Field(description="Agent that performs the task (see agent_list)")
    title: str = Field(min_length=3, max_length=120, description="Short title shown to the owner")
    task: str = Field(min_length=10, description="Self-contained instructions; prerequisite results are appended")
    depends_on: list[str] = Field(default_factory=list, description="Ids of tasks whose results this task needs")
    reason: str = Field("", max_length=500, description="Why this agent was selected")
    retries: int = Field(0, ge=0, le=2, description="Retries after a failure (use 1 for flaky or long tasks)")


class RunPlanArgs(Args):
    tasks: list[PlanTaskArgs] = Field(min_length=1, max_length=10)
    max_parallel: int = Field(3, ge=1, le=5, description="Independent tasks run at the same time, up to this many")
    stop_on_failure: bool = Field(True, description="Stop starting new tasks after a failure")


async def agent_run_plan(args: RunPlanArgs, ctx: ToolContext) -> ToolResult:
    from pae.runtime.plans import PlanError, PlanTask, execute_plan

    for item in args.tasks:
        _check_allowed(ctx, item.agent_id)
    parent = ctx.manager.context_of(ctx.run_id)
    tasks = [
        PlanTask(
            id=t.id,
            agent_id=t.agent_id,
            title=t.title,
            task=t.task,
            depends_on=list(t.depends_on),
            reason=t.reason,
            retries=t.retries,
        )
        for t in args.tasks
    ]
    try:
        outcome = await execute_plan(
            parent, tasks, max_parallel=args.max_parallel, stop_on_failure=args.stop_on_failure
        )
    except PlanError as exc:
        raise ToolError(f"invalid plan: {exc}") from exc
    lines = [
        f"Plan {outcome['plan_id']}: {outcome['completed']} completed, {outcome['failed']} failed, "
        f"{outcome['skipped']} skipped."
    ]
    for task in tasks:
        result = outcome["results"][task.id]
        lines.append(
            f"\n## Task {task.id} ({task.agent_id}): {result['status']}"
            + (f" after {result.get('attempts')} attempts" if (result.get("attempts") or 0) > 1 else "")
            + f"\nrun: {result.get('run_id')}"
            + (f"\nerror: {result['error']}" if result.get("error") else "")
            + (f"\noutput:\n{truncate(_render(result), 20_000)}" if result["status"] == "completed" else "")
        )
    data = {"plan_id": outcome["plan_id"], "statuses": {t.id: outcome["results"][t.id]["status"] for t in tasks}}
    return ToolResult(truncate("\n".join(lines), 100_000), data, is_error=outcome["completed"] < len(tasks))


TOOLS = [
    Tool(
        "agent_list",
        "List the agents you may delegate to: responsibility, capabilities, boundaries, inputs.",
        NoArgs,
        agent_list,
        "read",
        "allow",
        "agents",
    ),
    Tool(
        "agent_delegate",
        "Delegate one self-contained task to another agent and wait for its result.",
        DelegateArgs,
        agent_delegate,
        "read",
        "allow",
        "agents",
        untrusted_output=True,
        timeout_s=3600,
    ),
    Tool(
        "agent_run_plan",
        "Run several tasks across agents with dependencies: independent tasks run in "
        "parallel, each task receives the results of its prerequisites, failed tasks can be retried.",
        RunPlanArgs,
        agent_run_plan,
        "read",
        "ask",  # the owner checks the plan before any work starts
        "agents",
        untrusted_output=True,
        timeout_s=7200,
    ),
]
