# Multi-agent collaboration, Agent Workspace and projects

## Collaboration model

All collaboration runs through one mechanism, the **plan executor**
(`backend/pae/runtime/plans.py`). A plan is a set of tasks, each assigned to one
agent, with dependencies:

| Field | Meaning |
|---|---|
| `id`, `agent_id`, `title`, `task` | Who does what. The task text must be self-contained |
| `depends_on` | Tasks whose results this task needs. If one does not complete, this task is skipped |
| `after` | Tasks that only have to finish first, whatever the outcome (used by sequential teams that continue on failure) |
| `reason` | Why this agent was chosen (shown to the owner) |
| `retries` | 0 to 2 retries after a failure; the next attempt receives the previous error |

Three entry points produce plans, so every collaboration emits the same events and
draws the same graph:

- **Orchestrator** (tool `agent_run_plan`): selects agents from `agent_list`
  (responsibility, boundaries, inputs) and runs a dependency plan. For one task it uses
  `agent_delegate`, a one-task plan.
- **Teams** (`agents/teams/*.toml`): `sequential` becomes a chain, `parallel` becomes
  independent tasks plus an optional consolidation task, and `orchestrated` becomes one
  "coordinate" task for the orchestrator, restricted to the team's members.
- **Any agent** with `agent_delegate` and a `delegates` allow-list.

Execution rules:

- Every task is a real child run of the assigned agent (`RunManager.run_child`), with
  its own tools, permission gate, approvals, limits and checkpoints. Nothing is simulated.
- Independent tasks run in parallel, up to `limits.max_parallel_members` (default 3).
  A task starts when its prerequisites completed.
- **Handoff**: a task's prompt gets the outputs of its prerequisites, each wrapped as
  `<untrusted_data source="handoff:<task>">` (6,000 characters max per result). Agents
  treat them as input to verify, not as instructions.
- **Failure**: retries first; then dependents are skipped. With `stop_on_failure`
  (the default) no new task starts after a failure; tasks already running finish.
- **Permissions**: delegation to an agent outside the caller's allow-list, to itself, or
  beyond the depth and fan-out limits is refused before any run starts. Plans with
  unknown ids, duplicates or cycles are refused.
- **Pause**: the owner can pause a root run. No new task starts until it is unpaused;
  tasks already running continue to their end. **Cancel** stops all running tasks.
- Team runs checkpoint completed task results, so a resumed team does not redo them.

### Events

Persisted before they are published (`source` is `runtime` unless noted):

| Event | Data |
|---|---|
| `plan.created` | `plan_id`, `created_by_run_id`, `max_parallel`, tasks with `agent_id`, `title`, `depends_on`, `after`, `reason` |
| `task.assigned` | `plan_id`, `task_id`, `agent_id`, `reason` |
| `handoff` | `from_task_id`, `to_task_id`, `from_run_id`, `to_agent_id`, `summary` |
| `task.started` | `task_id`, `child_run_id`, `attempt` |
| `task.retry` | `attempt`, `previous_error` |
| `task.completed` / `task.failed` / `task.skipped` | output preview and duration / error and attempts / reason |
| `plan.completed` | counts of completed, failed and skipped tasks |
| `run.paused` / `run.unpaused` | `source: user` |

## Execution graph

`GET /api/runs/{run_id}/graph` (`backend/pae/runtime/graph.py`) rebuilds the graph of a
run tree from the persisted runs, events and approvals. It is identical live, after a
page refresh and after a server restart (tested).

- **Nodes**: `root` (the run that started it), `task` (status `pending`, `running`,
  `waiting_approval`, `retrying`, `completed`, `failed`, `skipped`, `cancelled`, with
  attempts, child run ids, input summary, output preview, error, tools used, tokens,
  duration and pending approvals), `approval` (attached to the task whose run asked),
  and `result`.
- **Edges**: `delegates` (planner to task), `depends_on`, `handoff` (a result actually
  passed), `approval`, `consolidates` (final tasks to the result). An edge is `active`
  only while its target is running or waiting; nothing moves once a run is over.
- Nested plans (an orchestrator inside a team) hang under the task that created them.

`GET /api/workspace/executions?project_id=&status=` lists collaborative executions
(team runs and runs that delegated) with task counts, agents, pending approvals and
pause state. `POST /api/runs/{id}/pause` and `/unpause` control a root run.

## Live Workspace (UI)

**Live Workspace** in the sidebar (`/workspace`, `/workspace/<task id>`) follows any task, done
by one team member or by several. Every task the owner starts opens here.

| Area | What it shows or does |
|---|---|
| Landing | "In progress" and "Recently finished" tasks of the selected project; "Start a new task" goes to Home. Choosing a team yourself is under "Advanced" |
| Header | The request, project, plain status, "N of M steps done", who is involved, Pause / Resume, Stop, Steps or Detailed map, Technical details |
| Needs your approval | Plain description of each pending action with Approve / Reject |
| Steps (default view) | One card per step in dependency order: team member, what they do, status, "Received from ...", "Waiting for ...", result summary with the full result on demand, retries, duration. Nested plans are indented |
| Final result | The consolidated answer (outcome, summary, problems reported, full result, copy); or what went wrong and what you can do |
| Activity | A plain-language feed built only from recorded events; "Show every action" adds tool-level actions |
| Detailed map | The canvas generated from the graph (dependency columns, parallel tasks, nested plans, approval gates, result) with a node inspector. Only edges the API marks `active` animate |

The page refetches the graph when plan, task, handoff, approval or run events arrive over SSE.
There is no client-side simulation: if the runtime emitted nothing, nothing changes. Secrets
are redacted by the runtime before events are stored, and hidden chain-of-thought is never
stored, so the UI cannot show it. Wording and navigation: [user-experience.md](user-experience.md).

API notes for clients: the graph's `title` is the objective, the root node's `label`
names who runs it (agent or team). `GET /api/approvals?project_id=` filters approvals;
`/api/workspace/executions?status=running,waiting_approval` accepts several statuses.
Execution task counts come from each task's latest state (`total`, `completed`,
`failed`, `skipped`, `running`); `active_runs` counts child runs at work.

## Projects

A project (`/api/projects`, **My Projects** page) isolates one body of work:

| Isolation | How |
|---|---|
| Files | Each project has its own folder: a new one the platform creates in its own location, or a folder that already exists anywhere on the computer (not a whole drive, the user folder, a system folder or the platform's data folder). Folders cannot overlap; runs of the project stay inside it and its children inherit it |
| Private paths | Folders and files inside the project the owner marks private (backups, logs, real data): no tool opens, lists or searches them, including Claude Code's own file tools (its Grep and Glob are refused from a folder that holds a private path). `.env`, keys and certificates are always protected |
| Credentials | Secrets can be stored for one project; a run uses the project's secret first, then the global one. Other projects never see it |
| Execution data | Runs carry `project_id` (inherited by child runs). Runs, approvals and executions can be filtered by project; each run tree only contains its own events |
| Context | A project brief written by the owner is added to every agent's system prompt in that project. When the owner already worked on the folder with Claude Code, its memory index (`~/.claude/projects/<folder>/memory/MEMORY.md`) follows the brief, and every agent gets `project_memory_read` to open one note. Read-only: the platform never writes to that memory. The folder's own `CLAUDE.md` (and `.claude/CLAUDE.md`, unless private) is added too, as Claude Code loads it |
| Continuing work | A Claude Code step continues the newest saved session of the same agent in the same folder, from its own task or the earlier tasks it follows up (a retry continues the stopped attempt). Each continuation is a fork; sessions are never shared between agents. Transcripts stay in the platform's Claude Code home and go when their task is deleted or expires |

A project with runs cannot be deleted, only archived; an archived project accepts no
new runs. Projects can be scaffolded from the bootstrap templates (if a template file
already exists in the folder, creation is refused and nothing is kept).

In the UI: **My Projects** (list, a four-step creation wizard: name, folder, notes, check; a project
page with the notes for the team, passwords and keys, private folders and "Edit files without
asking"); Home can also create a project inline. Scaffolding stays an API feature. The project
switcher in the top bar scopes the Workspace, History, Approvals, the Dashboard's project
section and both launchers; "All projects" shows everything.

## Limits

- Pause applies between tasks. A running agent is not frozen mid-step.
- The parallelism limit is per plan; the global concurrency limit still applies.
- Handoffs pass outputs, not files: agents that need another agent's files work in the
  same project folder.
- Collaboration has been verified on the scripted test double (deterministic tests and
  the `runtime-contracts` eval). It has not been run on the real model yet.
