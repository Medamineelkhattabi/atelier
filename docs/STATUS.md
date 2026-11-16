# Implementation status

Last verified: 2026-11-16. Statuses mean:
**Tested**: implemented and covered by an automated test or a recorded check.
**Partial**: implemented, but part of it is not verified (the gap is stated).
**Unavailable**: not implemented, by decision or not yet.

## Definition of done

| # | Requirement | Status | Evidence |
|---|---|---|---|
| 1 | Starts with documented commands | Tested | `pae serve` smoke check (health, auth state, setup token); `docs/operations.md`; Docker below |
| 2 | Backend and frontend communicate | Tested | `tests/test_e2e_ui.py`, `tests/test_e2e_journeys.py` (Playwright, real server, built UI) |
| 3 | Database persists what is needed | Tested | Resume-after-restart test, API tests, retention test |
| 4 | Real agents registered and operational | **Partial** | 15 agents (v2 contracts: responsibility, boundaries, output envelope) load with no problems; each runs end to end on the scripted provider (`tests/test_agents.py`). **First real run done 2026-11-11**: Research Agent on Claude Code (`claude-opus-5-5`, Max subscription, `apiKeySource: none`, provider `firstParty`) completed in 2 steps with 1 tool call and a schema-valid result (run `a3e4d953`). Other agents not yet run live |
| 5 | Launch tasks through the interface | Tested | E2E: from Home in plain words (desktop and phone), and from the advanced launcher |
| 6 | Real-time execution events | Tested | `test_sse_streams_live_events_over_a_real_server` (incl. Last-Event-ID replay); E2E live timeline |
| 7 | Inspect tool calls and outputs | Tested | E2E + browser review of tool cards, permission checks, raw events |
| 8 | Multi-agent coordination | Tested (scripted) | One plan executor for orchestrator plans, delegation and teams: dependencies, parallel tasks, handoffs, retries, skipped dependents, approvals inside tasks, pause, cancel, allow-list refusals (`tests/test_collaboration.py`); Live Workspace driven in the browser. **First live team task 2026-11-11** (task `50c0fa5c`): Coordinator and Technical Writer on Claude Code (Opus 5.5), `apiKeySource: none`, completed. It showed the Technical Writer had no place for a document it does not write to a file, so the Coordinator asked twice; fixed (`content` field) |
| 9 | Human approval | Tested | Approve, reject, expire, cancel, deny policy, injection case; E2E inline approve and approvals-center reject |
| 10 | History and observability | Tested | E2E history; search/filter API test; dashboard counts test |
| 11 | Agent and integration configuration | Partial | API tested (overrides, enable, custom agents, settings validation, tool permissions, MCP). In the browser, only settings save was exercised; agent override save, secrets, tokens, MCP editing were not clicked through |
| 12 | Security controls tested | Tested | See the security table |
| 13 | Automated tests pass | Tested | Backend 387 passed, 1 skipped (symlink test needs admin rights on Windows), including 5 browser tests and 10 ACP tests; frontend 214 passed; type-checked build; ruff clean (2026-11-16) |
| 14 | Agent evaluation results | Partial | `runtime-contracts` (`pae eval`, no longer in the UI): 13/13 cases, 6 categories (scripted model: measures the platform, not model quality). `agents-live` (6 cases, rubric judging) is ready but **not run**: needs the subscription sign-in, and uses the subscription allowance |
| 15 | Failure and recovery verified | Tested | Retries, non-retryable errors, timeouts, step/token limits, crash and resume from checkpoint, 40-run stress. 2026-11-14: only the process that owns the data folder (the server; `pae/instance_lock.py`) recovers, purges and watches apps. A `pae eval` run next to the server had marked its running task interrupted and crashed a step (`test_a_command_next_to_the_server_leaves_the_servers_tasks_alone`, `test_a_platform_started_second_takes_over_when_the_first_stops`) |
| 16 | Installation and deployment docs | Tested | `docs/operations.md` commands were run as written |
| 17 | Clean deployment verified | Tested | Fresh image and empty volume: setup, 12 agents ready, eval 12/12 inside the container, data kept across restart, UI driven in Chromium, healthcheck healthy (Docker section) |
| 18 | Docs for maintenance and extension | Tested | `docs/01-architecture.md`, `docs/operations.md`, `docs/extending.md` |

## AI access (subscriptions, never API keys)

Design and limits: [subscription-architecture.md](subscription-architecture.md).

| Item | Status | Evidence / gap |
|---|---|---|
| `claude-code` on the owner's subscription | Tested (1 live run) | Adapter tests offline (events, permissions, env scrubbing, credential check, limit and overage stops). One live Research Agent run: signed in via `pae claude-login` (`authMethod: claude.ai`, `subscriptionType: max`), `apiKeySource: none`, Claude Code's own usage report `provider: firstParty`; usage 6,220 input / 1,323 output tokens, API-equivalent estimate $0.053 (not billed) |
| `scripted` test double | Tested | Used by every deterministic test and eval; labelled "no model" in the UI |
| Paid providers (`anthropic`, `openai-compatible`) | Removed | Code, settings, secrets fallbacks, `anthropic` package and UI options deleted; refused by `resolve`/`register` |
| No paid fallback | Tested | `tests/test_subscription.py`, `tests/test_claude_code.py`: paid env variables stripped, API-key sessions stopped before work, overage stops the run, Claude credentials cannot be stored |
| AI vendors' API keys for other agents | Tested | An ACP agent starts without `OPENAI_*`, `ANTHROPIC_*`, `GEMINI_API_KEY`, `GOOGLE_API_KEY` and other vendors' keys (`agent_environment`, `tests/test_acp.py`); the setting `engines.agents` holds no environment |
| Usage credits (account setting) | Unavailable to the platform | Can only be turned off by the owner in claude.ai Settings > Usage; the platform stops runs on the first overage signal |

## AI agents through the Agent Client Protocol

Any agent that speaks ACP (agentclientprotocol.com) can run a team member: Gemini CLI, Codex, GitHub Copilot, Cursor, goose, OpenCode, Qwen Code, Mistral Vibe, or one the owner adds (`pae/engines.py`, `pae/runtime/acp.py`).

| Item | Status | Evidence / gap |
|---|---|---|
| A team member on an ACP agent (`provider = "acp:<id>"`) | Tested (scripted agent) | `tests/test_acp.py` against `tests/fake_acp_agent.py`, a scripted ACP agent (no model, no network): initialize, session, prompt; streamed messages, thoughts and plan shown as whole messages; tool calls and their results in the activity; permission requests decided by the platform's rules (a path outside the project or a secret file refused without asking, owner approval, auto modes, a command the agent does not name still asks in auto mode, "allow once" chosen so the agent keeps asking); file reads and writes through the platform (a write the agent did not ask about is decided like an edit); the report read from the last message and asked for again when missing; step limit; a signed-out agent says how to sign in. **No real ACP agent has run yet**: launch commands come from the ACP registry (read 2026-11-16) and are not verified on a PC |
| Choosing the agent per team member | Tested | Team member page "Runs on", Tools & Connections "AI agents" (installed or not, how to install, how to sign in), advanced settings; `GET /api/engines`; setting `engines.agents` adds an agent or changes how one starts (component and API tests) |
| What an agent does without asking | Not in the platform's hands | The platform decides what the protocol shows it: permission requests and file access. An agent's own "approve everything" setting, or work it does inside itself, is up to that agent |
| Coordinator and delegation on an ACP agent | Unavailable | The Coordinator plans with platform tools only Claude Code can use today; a member with team tools is refused on an ACP agent with that explanation |
| Token counts for ACP agents | Unavailable | ACP reports no token usage; an ACP agent's steps are counted as its tool calls |

## Tools

| Tool | Status | Notes |
|---|---|---|
| `fs_list/read/search/write/delete` | Tested | Workspace confinement, protected files, binary refusal |
| `doc_extract_text/tables` | Tested | PDF, DOCX, XLSX, CSV generated in tests |
| `data_profile/query/validate`, `sql_query` | Tested | Write statements rejected by the SQLite authorizer |
| `web_fetch`, `http_request`, `webhook_send` | Partial | SSRF blocking, domain allow-list, secret injection tested; no call to a real external service was made |
| `shell_run`, `code_run_python` | Tested | Minimal environment without secrets, timeout kills the process tree |
| Docker sandbox for execution (`shell.sandbox = docker`) | Partial | Implemented, not exercised by tests |
| `git_status/diff/log/commit` | Tested | Hooks disabled; ref injection refused |
| `email_send` | Partial | Implemented (SMTP, approval, recipient allow-list); not tested against a server |
| `agent_list`, `agent_delegate`, `agent_run_plan` | Tested | Allow-list, self-delegation refused, depth and fan-out limits, plan validation (cycles, unknown ids, duplicates) |
| MCP client (external servers) | Tested | Real stdio server: tools registered, gated, argument validation, failure reporting |
| Browser automation | Partial | Through an MCP server such as Playwright MCP; configuration documented, not set up or tested |

## Agent Workspace, collaboration and projects

Design: [agent-workspace.md](agent-workspace.md). All verified on the scripted test double (no model).

| Item | Status | Evidence / gap |
|---|---|---|
| Agent contracts (15 agents; Architect, Deployer and Security Engineer added 2026-11-13) | Tested | `tests/test_agents.py`: responsibility, boundaries, `works_with`, status/summary/issues envelope, incomplete-task handling, read-only agents have no write tools, acting agents state approvals, orchestrator coordinates only through the runtime |
| Dependency plans: parallel, sequential, handoffs | Tested | Overlap and ordering measured from run timestamps; handoffs wrapped as untrusted data |
| Failure, retry, skip, stop on failure | Tested | Retry gets the previous error; dependents skipped; independent work continues when asked |
| Approvals inside delegated tasks | Tested | Gate shown on the task node, approved from the inspector in the browser |
| Pause / resume / cancel | Tested | Pause holds new tasks (running ones finish); cancel stops all tasks; both in the browser. Pause is not kept across a server restart |
| Execution graph from persisted events | Tested | Identical after a platform restart; rebuilt after a browser reload; a step whose last event is missing (interrupted plan) takes its state from its own run, so a task that is over shows no step at work |
| Live canvas updates | Tested | Browser follows real statuses (running, waiting_approval, completed, cancelled); no animation once a run is over |
| Projects: folders, context, secrets, run data | Tested | `tests/test_projects.py`: no overlapping folders, runs confined to the project folder, project secret overrides global, project brief in the system prompt, two projects running at once never share events, secrets or files; migration 0002 keeps existing secrets |
| Phone width | Tested | 12 pages at 380 px without horizontal scroll (browser test) |
| Real-model collaboration | Partial | Run once on the real model (13-14 Nov 2026, a status-page change in a web app): it ended "partly done" after 2 h 50 for a change that takes about 25 minutes (approval waits counted against the task; fixed since), and its last security re-check never ran. The change itself was right. Nothing has run through the team since |
| Direct mode on the real model | Partial | Run once, 16 Nov 2026, side by side with a plain Claude Code session on the same request, model and starting commit (a fix in a production web app). Atelier: 46 min, 40 model calls, 172k new tokens, 3.4M cache re-reads, full suite green, then its automatic security review (2.5 min) passed it with one warning. Claude Code: 59 min, 70 calls, 218k new tokens, 12.6M re-reads, full suite green, no review. A blind review preferred Atelier's change (18/25 against 15/25) but found neither ready: both relaxed an earlier security decision of the project, which only Atelier's security review had flagged. Seen on the real page: the engineer's summary showed raw Markdown. One task only |
| Other browsers | Partial | Only Chromium was exercised (light screens by default, dark on a switch: both in the desktop journey) |

## User experience

Decisions and vocabulary: [user-experience.md](user-experience.md). Verified in Chromium against a real server, the model replaced by the labelled scripted test double.

| Item | Status | Evidence / gap |
|---|---|---|
| Home: describe a goal, pick or create a project, start, see what needs you | Tested | `test_desktop_journey_from_home_to_results`, `test_phone_journey` |
| Navigation by activity (Home, Live Workspace, My Work, Approvals, My AI Team, My Projects, Tools & Connections, Settings); old addresses redirect | Tested | Journeys + redirect checks |
| Plain-language team, approvals, statuses, results | Tested | Component tests (`plain.test.ts`, page tests) and journeys |
| Live Workspace steps view, final result, activity from real events; detailed map kept | Tested | Journeys; `steps.test.ts`, `activity.test.ts` |
| Phone layouts | Tested | 16 screens at 390 px without sideways scrolling |
| "Connect my Claude subscription" button | Partial | Opens Anthropic's sign-in window on Windows (loopback only); unit-tested with the window launch replaced. Not clicked for real (it would start a real sign-in) |
| Quality-check runs kept out of the owner's lists | Tested | `origin` field, migration 0003 backfill test |
| The owner checks every plan before work starts ("Start the plan" / "Change it" with a note) | Tested | `test_the_owner_checks_a_plan_before_any_work_starts`, browser journeys |
| Follow-ups: continue a finished task with only its request and result as context | Tested | `test_a_finished_task_can_be_continued_with_only_its_request_and_result`, browser journey |
| Per-project "Work without asking": file edits, plus commands that only read the project or run its checks (unit tests, type checks, builds; pytest only with a `-m "not ..."` selection); anything else, private paths and protected files still ask | Tested | `test_a_project_can_let_the_team_edit_files_without_asking`, `test_safe_commands.py` (24 safe and 40 refused commands, including the ones the first real coding task ran). Each Claude Code command starts in the project folder (`CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR`); not yet seen in a live run |
| Screens trimmed to what the owner needs | Tested | Quality checks, manual team launchers, starter files, project labels and the Claude Code link removed from the UI (backend kept); text cut on every screen (e.g. My AI Team 1,299 → 336 words) |
| Project in an existing folder anywhere, with private paths | Tested | `test_an_existing_folder_anywhere_can_be_a_project`, `test_unsafe_folders_are_refused`, `test_claude_code_searches_never_reach_private_folders` (Claude Code's Grep/Glob are refused from a folder that holds a private path, and their file patterns cannot leave the project) |
| Limits sized for real coding work | Tested | First real coding step (an Accounts screen) stopped at 30 turns and was then failed on 3.1M "tokens", 2.9M of them cache re-reads. Now: 150 turns per step, 2 h per task, only new tokens count, and usage past a limit (known only after a Claude Code session) is reported without discarding the work (`test_a_long_session_keeps_its_work_and_only_new_tokens_count`, `test_a_session_out_of_turns_says_so`). 2026-11-13: time spent waiting for the owner (an approval, a paused plan) no longer counts: the first task under the new team failed at 2 h after 11 min of work and 1 h 50 of waiting. Every clock of the task stops while the owner is awaited (`RunContext.deadline`, `RunManager.owner_awaited`; `test_waiting_for_the_owner_does_not_use_up_the_tasks_time`, `test_waiting_for_the_owner_stops_every_clock_above_the_waiting_step`). A stopped Claude Code step keeps the tokens it used, counted message by message (`test_a_stopped_step_keeps_the_tokens_it_used`). 2026-11-14: background commands are off in team sessions (`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS`) and one command may run 45 min (`BASH_MAX_TIMEOUT_MS`, Claude Code's default is 10): a step had left a project's full test suite running in the background, reported without its result, and the session continued later first answered the leftover notice, which ended that step at once (`test_commands_run_in_the_foreground_with_room_for_a_full_test_suite`) |
| Security Engineer reviews every code change | Tested | Strict, read-only agent (`read_only = true`: the platform refuses its edits; Bash only runs read-only commands and report-only scanners `npm audit`, `pip-audit`, `bandit`, `gitleaks`, `osv-scanner` when installed; `pip-audit` 2.10, `bandit` 1.9 and `gitleaks` 8.30.1 (checksum-verified, only with `--redact`, redaction checked on a fake token) installed 2026-11-13 by `scripts/install-security-tools.ps1`, with `npm audit`). Verdict pass / pass_with_warnings / block with file, line, exploit and fix per finding. The Coordinator adds a security task after every code task (fix and re-check on block, two rounds, never deploy a blocked change); a task given straight to the Software Engineer or the Debugger that changed files gets a review automatically (`pae/runtime/security_review.py`, setting `security.review_changes`), and a block sends a Windows notification. Quality checks always run in "ask" mode. `tests/test_security_review.py`; not yet run live |
| Direct mode in code projects, and a lighter review loop (2026-11-14) | Tested | The first real task through the team took 2 h 50 for a change made in 25 min. Now: a project whose folder holds code has `direct_member = software-engineering` (`pae/projects.py`); Home sends its requests straight to that one session ("works on it directly, like Claude Code"), the Coordinator is one choice away. The engineer (v2.2.0) handles the whole request when addressed directly and leaves the project clean. The Coordinator (v2.3.0) starts a fix round only for a "block", once; warnings go to the owner. Under a blocking review, "Fix what blocks" (and any follow-up) goes to the engineer who made the change, in its own session, with the findings. A Claude Code session that ends a turn without its report is asked for it (twice at most) instead of failing. Scanners given one file read that file (`gitleaks dir <file>` was refused). Windows notifications when the owner's task ends after more than a minute and when a task waits for an approval (at most every 5 min per task). `HomePage.test.tsx`, `WorkspacePage.test.tsx`, `test_what_the_owner_asks_after_a_review_goes_to_the_engineer`, `test_a_session_that_ends_without_its_report_is_asked_for_it`, `test_the_owner_is_told_when_a_task_waits_or_ends_while_they_are_away`, `test_safe_commands.py` |
| Auto-approve mode (like Claude Code's bypass) and the owner's name | Tested | Settings > Account: "Approve actions automatically" (`permissions.mode` = auto) turns every "ask" into "allow", plans included, except deploying, changing or inspecting the running app's containers, git push, publishing, other machines, sending data out (POST, e-mail, webhooks, MCP), changing the PC outside the project and commands naming a path outside the project (`pae/runtime/auto_approve.py`). `permissions.mode` = all (second switch, "Also deploys, pushes and sending data out"; the owner's choice 2026-11-13) removes those exceptions too. In both modes a command naming a private path or a secret file is refused at once (2026-11-13: in "all" mode it used to run). Refusals and the owner's explicit ask/deny rules are unchanged; read-only tasks stay read-only. `owner.name` tells every agent whom it works for (the Claude account shows another name). `tests/test_safe_commands.py` (18 commands that still ask, 12 that run), `test_settings_take_the_owners_name_and_the_approval_mode` |
| Platform starts at Windows logon | Tested | Scheduled task "Personal AI platform" (`scripts/install-autostart.ps1`, hidden through `conhost --headless`, in the owner's session for notifications); registered on the real PC 2026-11-13 and started the server (health ok). Not yet seen across a real reboot |
| App watcher with Windows alerts | Tested | Per project "Watch the app" (needs a docker-compose file). Every 2 minutes, free: `docker compose ps`/`logs` and a request per published port; alerts on Docker down (3 checks), a service restarting/dead/unhealthy or a port not answering (2 checks), new error lines (signatures, 6 h before the same one again), 3+ failed requests in a check, the project's own patterns and long tasks that never end. Stopped services and fresh restarts are left alone. A problem sends a Windows notification (no outside service, no log content) and starts a read-only Debugger task (edits, restarts, deploys refused; 4 per day); its result sends a second notification. `tests/test_watch.py` with a fake Docker; checked against a real app's containers and log formats. Not yet seen alerting on a real incident |
| Architect and Deployer | Tested | Architect: read-only design (options, recommendation, plan for the Software Engineer). Deployer: the project's own procedure, every build/deploy/restart needs the owner's approval, checks before and after. Read-only Docker commands (`docker ps`, `docker logs`, `docker compose ps|logs`) count as safe; `inspect`, `config`, `--env-file` and following never do. Contracts in `tests/test_agents.py`; not yet run live |
| Steps work like a Claude Code session the owner continues | Tested | Agents with Claude Code's own tools keep Claude Code's system prompt (platform instructions appended). Sessions are saved in the platform's Claude Code home; a later step, retry, resume or follow-up of the same agent in the same folder continues the newest one as a fork (`pae/runtime/sessions.py`, `test_a_follow_up_continues_the_earlier_session`, `test_a_step_in_the_same_task_continues_the_stopped_attempt`), never across agents. Deleting or expiring a task deletes its transcripts. The Coordinator keeps one code change in one engineering step, review only when asked or risky. The project's `CLAUDE.md` joins the context. Not yet seen in a live run |
| Project reuses the owner's Claude Code memory for its folder | Tested | `test_a_project_reuses_claude_codes_memory_for_its_folder`: the memory index joins every task's context, `project_memory_read` opens one note (read-only, memory folder only). Not yet tried in a live run |
| Light and dark screens | Tested | Light by default; Settings › Appearance and the menu switch (light, dark, same as the computer); kept across reloads (browser test) |
| A code change and its security review read at a glance (2026-11-15) | Tested | Found by walking the direct path in a browser for the first time: a review that blocked a change showed "Done / Fully done" in green, its title was the reviewer's instructions (markup and task id included), and the changed task never said a review existed. Now: a review is titled "Security review: <the owner's request>" (`review_task`); its page and My Work show the verdict ("Blocks the change" in red, "Passed with warnings", "Nothing blocks") instead of "Fully done", with each finding in sight (severity, file:line, fix); the changed task's page says where its review stands and links to it (`security_review` in `GET /api/runs/{id}`, re-read every 3 s until the review has decided); a code change shows its files and whether its own check passed, a failed check in red. `test_direct_journey_in_a_code_project` (browser: Home, change, block, "Fix what blocks", fix, pass, My Work), `test_security_review.py`, `WorkspacePage.test.tsx`, `plain.test.ts` |
| Results shown with formatting | Tested | Team members' Markdown (headings, tables, lists, code) rendered safely, without raw HTML (component and browser tests) |
| Screen readers | Partial | Accessible names checked by tests; not tried with a screen reader |

## Security

| Control | Evidence |
|---|---|
| Authentication, setup token, login rate limit | `test_setup_requires_token_and_happens_once`, `test_login_rate_limit_and_logout` |
| CSRF on cookie sessions; bearer tokens for automation | `test_csrf_is_enforced_for_cookie_sessions`, `test_api_tokens_for_automation` |
| Secrets write-only, encrypted, redacted everywhere | `test_secrets_are_write_only`, `test_secrets_are_redacted_from_events`, Claude Code env test |
| Agent and tool permissions, deny precedence | `test_global_deny_overrides_agent_allow`, `test_tool_not_in_agent_allowlist_is_refused` |
| Filesystem boundary | Traversal, absolute paths, protected files, symlinks (skipped on Windows), static-file traversal |
| Prompt injection does not bypass gates | `test_prompt_injection_cannot_bypass_approval`, eval `injected-instruction-is-gated`, untrusted wrapping test |
| SSRF | Loopback, private, link-local, metadata and non-HTTP URLs refused |
| Security headers | `test_security_headers_and_no_store` |
| Limits and timeouts | Run timeout, step, token, cost limits; approval expiry; concurrency limit under stress |
| Audit log | Owner actions recorded (approvals, settings, secrets, runs, projects) |
| Project isolation | Folders, secrets and events separated per project (`tests/test_projects.py`) |

## Not implemented (decisions)

| Item | Decision |
|---|---|
| PostgreSQL | SQLite only: one owner, one node. SQLAlchemy keeps a switch possible; not verified |
| Long-term agent memory | Not added. Runs keep their full history and checkpoints; no use case yet justifies a memory store |
| Agent frameworks (LangGraph, Pydantic AI) | Not adopted; see the architecture decisions |
| Multi-user accounts and roles | Single owner by design |
| Resuming Claude Code sessions mid-run | Not supported: an interrupted Claude Code run restarts from the beginning |

## Docker

Verified on 2026-11-11 with `docker build -t pae:local .` (image 1.41 GB) and a
fresh container on an empty volume:

- `/api/health` ok; Docker healthcheck `healthy`; process runs as the non-root user `pae`.
- Owner setup with `PAE_SETUP_TOKEN`; 12 agents loaded, all ready, no load errors.
- The Claude Code CLI bundled in the Linux image is found (auth not configured, as expected).
- `runtime-contracts` eval run through the API inside the container: 12/12.
- After `docker restart`: owner, run, events and eval results all still there.
- The built UI served by the container, driven in Chromium: sign-in, dashboard, history, run page; no page errors.
- `compose.yaml` validated with `docker compose config` (the stack itself was started with `docker run`, same image and volume layout).

Re-verified after the subscription-only change (image rebuilt, no model call): started
with a fake `ANTHROPIC_API_KEY` and `CLAUDE_CODE_USE_BEDROCK`, the platform removed both
at startup; the `anthropic` package is absent; only `claude-code` and `scripted` are
offered; the status reads "not signed in" with the Claude Code home `/data/claude-home`;
a run on `anthropic` and storing `ANTHROPIC_API_KEY` were both refused (HTTP 400).

## Open items

1. Run each ACP agent once for real (Gemini CLI, Codex, GitHub Copilot first) and record the result here.
2. `pae eval agents-live`: ready, not run (it uses a subscription's allowance).
3. MCP servers for browser automation and GitHub, and SMTP, are configured by the owner; not set up here.
