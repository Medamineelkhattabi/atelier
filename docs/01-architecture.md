# Platform architecture

A local-first, single-owner platform for defining, running, supervising and
reusing AI agents. Domain-neutral: no business logic of any consuming project
lives here.

## Decisions

| Concern | Choice | Why (and what was rejected) |
|---|---|---|
| Backend | Python 3.12, FastAPI, Pydantic v2 | Agents, tools and document processing are Python-native; FastAPI gives typed APIs, OpenAPI and async streaming in one place |
| Persistence | SQLAlchemy 2 + SQLite (WAL), Alembic migrations | One owner, one node: SQLite is reliable, zero-ops, and backs up as one file. PostgreSQL adds a service with no benefit at this scale; SQLAlchemy keeps the switch possible, but it is **not verified** |
| Background execution | In-process asyncio run manager, bounded concurrency, persisted checkpoints | Celery/Redis would add two services to solve a multi-node problem we don't have. Recovery comes from checkpoints, not from a broker |
| Real-time | Server-Sent Events, replay by event sequence number | One-way server-to-browser is all the UI needs; SSE reconnects natively and works through plain HTTP |
| Frontend | React + TypeScript + Vite, Tailwind CSS, TanStack Query | A mature, typed SPA stack; Query handles cache and refetch so pages reflect backend state. Served by the backend in production |
| AI access | **Subscriptions, never API keys**: `claude-code` (the unmodified Claude Code binary, driven by the Claude Agent SDK, signed in through Anthropic's own flow), `acp:<id>` (any agent that speaks the Agent Client Protocol, on its own sign-in: Gemini CLI, Codex, GitHub Copilot, Cursor...) and `scripted` (deterministic test double, no model) | No API key, no pay-per-token, no paid fallback. Paid providers were removed; ACP keeps one client for many agents instead of one adapter per vendor. Guards are described in [subscription-architecture.md](subscription-architecture.md) |
| Agent frameworks | None (LangGraph, Pydantic AI evaluated, not adopted) | The loop, tools, approvals and events are ~1k lines we fully control and test. A framework would hide the exact behaviour we need to observe and gate |
| Agent definitions | TOML files in `agents/`, plus DB overrides and custom agents created in the UI | Version-controlled and reusable across projects; `tomllib` is in the standard library |
| Tools | Python registry with schemas, risk levels and permission policies; MCP client for external servers | Every tool call goes through one permission and approval gate. MCP covers integrations that already have servers (browser, GitHub...) instead of custom code |
| Auth | Single owner account, scrypt password hash, HttpOnly session cookie + CSRF header, bound to 127.0.0.1 by default | Fits a personal platform; no external identity provider to depend on |
| Secrets | Fernet-encrypted in the DB, key file in the data directory (outside Git); only a masked hint is ever returned | Secrets survive restarts without living in plaintext, and the UI cannot re-display them |
| Deployment | One Docker image (frontend built in a Node stage, served by the API), Compose with a persistent volume | Reproducible, one command, one volume to back up |

## Components

```
 Browser (React SPA) ──HTTP/JSON + SSE──► FastAPI
                                           ├── api/        routes, auth, CSRF, rate limits
                                           ├── runtime/    run manager, native loop, Claude Code loop, plans,
                                           │               teams, execution graph, approvals, limits, recovery, events
                                           ├── providers/  claude-code (subscription) | scripted (test double)
                                           ├── tools/      fs, documents, data, http, shell, git, delegate, mcp
                                           ├── agents/     registry: TOML definitions + DB overrides
                                           ├── evals/      suites, deterministic + model-graded checks
                                           ├── projects    isolated folders, context, project-scoped secrets
                                           └── db          SQLite: projects, agents, runs, events, approvals, secrets, settings
 pae CLI ── init (project bootstrap), eval, mcp-serve (exposes agents to Claude Code in any project)
```

## Execution model

**Run lifecycle:** `queued -> running <-> waiting_approval -> completed | failed | cancelled | interrupted`.
A run belongs to one agent; team runs own child runs (`parent_run_id`), giving a run tree.

**Native loop** (scripted test double only; real runs use the Claude Code loop): build the request from
the agent's instructions, the task and the checkpointed messages; call the
provider with retry and backoff; for each tool call, check permission, wait for
approval if needed, execute with a timeout, append the result; repeat until the
agent calls `final_answer` (validated against its output schema) or ends its turn.
The message list is checkpointed after every step.

**Claude Code loop** (`claude-code` provider): the Claude Agent SDK drives a
headless Claude Code session. Platform tools are mounted as an in-process MCP
server, so they run in our process behind the same permission gate. Claude Code's
own tools (only for agents that list them) pass through the SDK permission
callback into the same approval center. User settings, plugins and MCP servers
are not loaded into these sessions.

**Events** are persisted before they are published, each with a run-scoped sequence
number and a `source`:

| source | Meaning |
|---|---|
| `agent` | Something the model did: text, reasoning summary, tool call, final answer |
| `tool` | Observed tool execution: start, output (redacted), error |
| `runtime` | Orchestration: status changes, retries, limits, delegation, recovery |
| `user` | Owner actions: approvals, rejections, cancellation |

No event is synthesized to look like model activity. Raw chain-of-thought is never
stored; only provider-supplied reasoning summaries and visible text.

**Limits** per run: max steps, wall-clock timeout, max tokens, max estimated cost,
per-tool timeout, output size cap; global max concurrent runs.

**Recovery:** on startup, runs left `running` become `interrupted`. Resume restarts
from the last checkpoint; a pending tool call is re-checked against policy, never replayed blindly.

## Capabilities and how each is implemented

| Capability | Implementation | Tools (permission) |
|---|---|---|
| Research | Native agent, findings with evidence and source ids | `web_fetch` (ask outside allowed domains), `fs_*` read, `doc_extract_text` |
| Planning | Native agent, tasks with done-criteria, dependencies and a suggested agent each | `fs_*` read, `git_log`, `git_status` |
| Software engineering | Claude Code loop with file tools confined to the workspace | Read/Glob/Grep (allow), Edit/Write (ask), Bash (ask) |
| Code review | Native agent, read-only, every finding with file, line and evidence | `fs_*` read, `git_diff`, `git_log` |
| Debugging | Claude Code loop; no code change before the cause is reproduced or proven | as software engineering |
| Testing | Native agent; classifies failures (product bug, test bug, environment) | `fs_*` read, `shell_run` (ask), `fs_write` (ask) |
| Documentation | Native agent, documents only what it verified | `fs_*` read, `fs_write` (ask) |
| Automation | Native agent; every external side effect approved | `http_request` GET to allowed domains (allow), other methods (ask), `webhook_send`, `email_send` (ask) |
| Data | Native agent over deterministic tools; every number from a tool result | `data_profile`, `data_query`, `data_validate`, `sql_query`, `code_run_python` (ask) |
| Document processing | Deterministic extraction tools, agent structures and validates, read-only | `doc_extract_text`, `doc_extract_tables`, `data_validate` |
| Orchestrator | Selects agents and runs dependency plans; no specialist tools | `agent_list`, `agent_delegate`, `agent_run_plan` (child runs keep their own gates) |
| Evaluator | Grades an output against a rubric, criterion by criterion | none |

Every agent reports `status` (`complete`, `partial`, `blocked`), `summary` and `issues`
plus its own evidence fields. Collaboration (orchestrator plans, delegation and teams)
runs through one plan executor with dependencies, parallel tasks, handoffs, retries and
an execution graph rebuilt from events: see [agent-workspace.md](agent-workspace.md).
Projects isolate folders, secrets and run data: same document.

## Security controls

- Tools only touch paths inside the run's workspace root (resolved, symlinks
  followed, traversal rejected). There is no general shell: `shell.run` is
  approval-gated, has a timeout, runs in the workspace, and gets a minimal environment with no secrets.
- Permission resolution: a `deny` at any layer wins; otherwise the first layer that
  sets a value decides, in the order global owner setting, agent definition or
  override, argument-based rule (e.g. GET to an allowed domain), tool default.
  Only the owner sets these layers; a model cannot change its own permissions.
- Tool output is wrapped as untrusted data. Injection defenses rely on the gate,
  not on the model ignoring the text.
- Secrets are redacted from events, logs, errors and tool output (exact values plus key patterns).
- Login rate limiting; per-run and global resource limits; audit log of owner actions; retention purge of old runs.

## Repository layout

```
backend/      Python package `pae` (API, runtime, providers, tools, evals, CLI) and its tests
frontend/     React SPA and its component tests
agents/       agent and team definitions (TOML)
evals/        evaluation suites
templates/    project bootstrap templates
docs/         architecture, status, operations
lessons/      learning exercises (independent of the platform)
```

## Acceptance criteria

Delivery is accepted when each item of the mission's Definition of Done has
evidence: an automated test, an eval result, or a recorded end-to-end check.
`docs/STATUS.md` tracks each one as implemented, tested, partial or unavailable.

## Main risks

| Risk | Mitigation |
|---|---|
| The `claude-code` provider depends on a CLI path that changes with app updates | Configurable path with auto-detection; health check shows status |
| Subscription limits, usage credits and sign-in expiry | Limit and overage stops, refusal while blocked, clear "not signed in" errors; see subscription-architecture.md |
| SQLite write contention with many parallel runs | WAL + busy timeout, short transactions, bounded concurrency; load-tested |
| Model nondeterminism makes agent tests flaky | Deterministic tests on the scripted provider; live evals reported as rates over several cases |
