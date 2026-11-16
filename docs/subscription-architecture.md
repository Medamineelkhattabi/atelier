# AI access: subscriptions, never API keys

**Constraint:** Atelier runs AI only through agents signed in with their user's own plan:
Claude Code on a Claude subscription, or an agent that speaks the Agent Client Protocol
(Gemini CLI, Codex, GitHub Copilot, Cursor, goose, OpenCode, Qwen Code...) on its own sign-in.
No API key, no API credits, no pay-per-token calls, no paid provider integration, no
automatic paid fallback. Each agent is used under its own vendor's terms.

## What Anthropic's documentation says (checked 2026-11-11)

| Topic | Source | What it means here |
|---|---|---|
| Subscription sign-in | Claude Code *Legal and compliance*: OAuth is "designed to support ordinary use of Claude Code"; the terms don't "prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription" | The platform drives the **unmodified Claude Code binary**, signed in with the owner's own subscription |
| Credential handling | Same page: developers "may not collect, store, or intermediate Claude.ai credentials or session tokens — sign-in to a Claude account must complete through Anthropic's own flow" | The platform never asks for, reads or stores a Claude credential. Sign-in happens in Claude Code's own `auth login` flow |
| Who may use it | Same page: no offering "Claude.ai login into their own applications" or routing requests "on behalf of their users"; Agent SDK overview: no offering "claude.ai login or rate limits" for third-party products | Atelier runs locally for the person who installs it, with their own sign-in. It is never hosted for others and never routes one person's requests through another's account. **Offering Atelier commercially with Claude sign-in may need Anthropic's approval: check before selling it** |
| Expected volume | Same page: plan limits "assume ordinary, individual usage of Claude Code and the Agent SDK" | Owner-initiated runs with modest concurrency, not unattended mass automation |
| Headless mode | *Run Claude Code programmatically*: `claude -p` and the Agent SDK run the same agent loop | Programmatic use of Claude Code is a documented mode |
| `--bare` | Same page: bare mode "never reads OAuth credentials" | Never used: it cannot run on a subscription |
| Credential precedence | *Authentication*: cloud-provider variables, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY` ("in non-interactive mode (`-p`), the key is always used when present"), `apiKeyHelper`, `CLAUDE_CODE_OAUTH_TOKEN`, Anthropic profiles, then the subscription `/login` | A stray API key would silently win over the subscription: the platform removes all of them |
| Separate login per home | *Authentication*: each `CLAUDE_CONFIG_DIR` has its own claude.ai login | The platform gets its own Claude Code home, separate from your personal `~/.claude` |
| Usage limits | Support article *Using Claude Code with your Pro or Max plan*: five-hour and weekly limits, "shared across Claude and Claude Code" | Platform runs consume the same allowance as your claude.ai chats |
| Usage credits | Support article *Usage credits*: when enabled, requests "switch to pay-as-you-go pricing … and keep working", including Claude Code; off in Settings › Usage | The only paid path the platform cannot switch off itself: keep it disabled on your account |

This is a reading of public documentation, not legal advice. Anthropic's pages
also say developers building products with the Agent SDK should use API keys;
this platform stays within the end-user case by being a personal tool that runs
your own Claude Code with your own sign-in.

## Architecture

```
 Browser ──► FastAPI (pae) ── RunManager ── every real run ──► Claude Code loop (runtime/claude_code.py)
                                                                  │  Claude Agent SDK (pinned) spawns
                                                                  ▼
                                   unmodified Claude Code binary  ─── claude.ai subscription login
                                   CLAUDE_CONFIG_DIR = <data>/claude-home   (made with `pae claude-login`)
                                   no settings files, no plugins, strict MCP, --restricted, never --bare
                                                                  │
                     platform tools mounted as an in-process MCP server ("pae"), every call
                     and every Claude Code built-in tool call goes through the platform gate
                     (permissions, approvals, workspace boundary, redaction, events)
```

- **One execution backend.** All agents, team members, delegated runs and the
  eval judge run as Claude Code sessions. The platform's own model loop remains only
  for the `scripted` test double (no model, no network).
- **Providers:** `claude-code` and `scripted`. Nothing else can be selected,
  configured, stored or registered (`pae/subscription.py`, `pae/providers/registry.py`).

## Which agents run on the subscription

All of them, through Claude Code:

| Agent | Tools inside the Claude Code session | Notes |
|---|---|---|
| Research | platform `web_fetch`, `fs_*`, `doc_extract_text` | Web access only through the platform's allow-listed fetch |
| Planning | platform `fs_*`, `doc_extract_text` | |
| Software engineering | Claude Code `Read/Glob/Grep/Edit/Write/Bash`, platform `git_*` | Edits and commands need your approval |
| Code review | platform `fs_*`, `git_*` | Read-only |
| Debugging | as software engineering | |
| Testing | platform `fs_*`, `shell_run`, `fs_write` | Commands need approval |
| Documentation | platform `fs_*`, `doc_extract_text`, `fs_write` | Writes need approval |
| Automation | platform `http_request`, `webhook_send`, `email_send`, `fs_*` | External calls need approval |
| Data | platform `data_*`, `sql_query`, `doc_*`, `code_run_python` | |
| Document processing | platform `doc_*`, `data_validate` | |
| Orchestrator | platform `agent_list`, `agent_delegate` | Each delegate is another Claude Code session |
| Evaluator (judge) | none | Used only by live evals |

Teams work the same way; a parallel team runs at most `limits.max_parallel_members`
(default 3) members at once.

## Guarantees against paid usage

| Layer | What it does | Test |
|---|---|---|
| No paid provider exists | `anthropic` and `openai-compatible` providers and the `anthropic` package were removed; `resolve()` and `register()` refuse anything but `claude-code`/`scripted` | `test_platform_refuses_paid_paths`, `test_paid_providers_are_refused` |
| No credential storage | Secrets named `ANTHROPIC_*`, `CLAUDE_CODE_OAUTH_TOKEN`, `OPENAI_*` are refused | `test_secrets_are_write_only` |
| Environment scrubbed | At startup and before every session, `ANTHROPIC_*`, `CLAUDE_CODE_USE_*`, `AWS_BEARER_TOKEN_BEDROCK` and related variables are removed from the process, so Claude Code cannot inherit them | `test_paid_credential_variables_are_scrubbed`, Claude Code env test |
| No settings-based helpers | Sessions load no user/project settings (`apiKeyHelper` cannot come from them) and only the platform's MCP server | adapter test |
| Credential check | Claude Code's first message reports `apiKeySource`; anything other than `none` (a claude.ai login) stops the session before any work | `test_session_on_an_api_key_is_stopped_before_any_work` |
| Limit stop | At the plan limit, the run stops; new runs are refused until the reported reset | `test_plan_limit_stops_the_run_and_blocks_new_runs` |
| Overage stop | If Claude Code reports overage (usage credits) state, the run stops immediately | `test_paid_overage_is_never_used` |
| Never `--bare` | Bare mode would require an API key | adapter test |

## Limitations

| Limitation | Why | Closest supported alternative |
|---|---|---|
| Usage credits are an account setting | Once enabled, Claude Code uses them automatically after the limit; the platform only learns it from Claude Code's rate-limit event, so a request already in flight could be billed | Turn usage credits off in claude.ai Settings › Usage. Then Claude Code simply stops at the limit |
| Shared five-hour and weekly limits | Platform runs and your claude.ai chats draw on one allowance | Low default concurrency (2 runs, 3 parallel members); usage warnings in the timeline; runs refused while the limit is reached |
| Personal use only | Terms: no claude.ai login for other users, no requests on their behalf | Each person who wants this platform runs their own copy with their own subscription |
| No unattended fleet | Limits assume "ordinary, individual usage" | Owner-initiated runs; API-token triggers exist but are for your own occasional automations |
| Models depend on your plan | Available models and the Fable weekly limit differ by plan | Leave the model empty (plan default) or use aliases like `sonnet` / `opus` |
| No direct API features | Only what Claude Code exposes: no batch discounts, prompt-cache control, token counting endpoint, Files API, exact `max_tokens` | Structured output through Claude Code's JSON schema; effort and model aliases |
| Interrupted runs restart | Claude Code sessions are not persisted, so resume starts the agent again | Possible later: keep sessions in the platform's Claude home and resume them |
| Sign-ins expire | A claude.ai login can expire and need renewing | Runs fail with "not signed in"; run `pae claude-login` again |
| Future CLI defaults | Docs say `--bare` may become the default for `-p`; that would break subscription sign-in | CLI version is pinned (claude-agent-sdk 0.2.180, Claude Code 2.1.321); re-verify before upgrading. Failure would be closed (auth error), never paid |
| Costs shown are estimates | Claude Code reports an API-equivalent `total_cost_usd`; on a subscription nothing is billed per token | Shown as "usage estimate, not billed"; real consumption is your plan's usage page |
| Agent SDK terms ambiguity | The SDK's docs point product developers to API keys | The SDK is used only to run your unmodified Claude Code with your own sign-in. If that were ever ruled out for personal use, the same loop can be driven through `claude -p` directly; the driver is isolated in `runtime/claude_code.py` |

## Operating it

1. Sign in once (opens Anthropic's login; nothing passes through the platform):
   `cd backend && .venv/Scripts/pae claude-login`. Check with `pae claude-status`.
   Docker: `docker compose exec -it pae pae claude-login` (the login lives in the data volume;
   Claude Code prints the sign-in URL to open on your machine; not yet tried in the container).
2. In claude.ai Settings › Usage, keep usage credits **off**.
3. Settings › Providers shows the sign-in state, the Claude Code home, and any usage-limit block.

## Not verified yet

No model call has been made under this design: signing in is your step, and the
investigation was done without generating tokens or touching authentication.
After you sign in, the first checks are one small agent run and then the
`agents-live` eval suite. Both use your subscription allowance, so they run only when you start them.

## Other agents: the Agent Client Protocol

A team member can run on any agent that speaks ACP (https://agentclientprotocol.com) instead of
Claude Code: `provider = "acp:<id>"` (`pae/engines.py`, `pae/runtime/acp.py`).

- **Sign-in**: the agent's own (Google account for Gemini CLI, ChatGPT plan for Codex, Copilot plan,
  Cursor plan...). The owner signs in once in the agent itself; Atelier never sees a credential.
- **No API keys**: the agent starts without AI vendors' API keys in its environment
  (`pae.subscription.agent_environment`), and the setting `engines.agents` cannot hold an environment.
  An agent's own configuration (for example goose or OpenCode set up with a key) is the agent's business:
  Atelier neither reads nor changes it.
- **Not installed by Atelier**: Tools & Connections shows each agent, whether it is installed, and the
  command to install it.
- **Same rules**: Atelier is the ACP client. Every permission the agent asks for and every file it reads
  or writes through the protocol is decided like a Claude Code tool call (workspace boundary, private
  folders, secret files, read-only tasks, approvals, auto modes). What an agent does without asking is
  up to that agent.
- **Limits**: no token counts (ACP does not report them), no session continuation, and the Coordinator
  stays on Claude Code (its planning tools are mounted in-process for Claude Code only).
