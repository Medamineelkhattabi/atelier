# Operations

## Run locally (development)

Prerequisites: Python 3.12, Node.js 22+ (24 tested), Git.

```bash
cd backend
python -m venv .venv
.venv/Scripts/python -m pip install -c requirements.lock -e ".[dev]"   # Windows path; .venv/bin/python elsewhere
cd ../frontend
npm ci
npm run build
cd ../backend
.venv/Scripts/pae serve
```

Open http://127.0.0.1:8600. On first start the log prints a one-time setup
token; use it to create the owner account. For frontend development, run
`npm run dev` in `frontend/` (Vite proxies `/api` to port 8600).

### Start at Windows logon

`scripts/install-autostart.ps1` registers the scheduled task "Personal AI platform": at each logon it runs
`scripts/start-platform.ps1` through `conhost.exe --headless` (no window), in the owner's session so Windows
notifications reach the screen. Logs: `~/.pae/server.log`. Stop the platform with `scripts/stop-platform.ps1`
(stopping the task alone leaves the server running), start it again with
`Start-ScheduledTask -TaskName 'Personal AI platform'`, remove the task with
`Unregister-ScheduledTask -TaskName 'Personal AI platform' -Confirm:$false`. Stop it before running `pae serve`
by hand (both use port 8600).

`pae eval` and `pae run` may run while the server runs: the server owns the data folder (`instance.lock`), so a
command next to it only runs its own tasks. It leaves the server's tasks and approvals alone, cleans nothing up
and watches no app (`pae/instance_lock.py`).

### Security scanners for the Security Engineer

`scripts/install-security-tools.ps1` installs `pip-audit` and `bandit` in their own environment
(`~/.pae/tools/venv`) and gitleaks from its official GitHub release (used only if its SHA-256 matches the
published checksums), and puts only these three commands in `~/.pae/tools/bin`. gitleaks only runs with `--redact`. The platform adds that folder at
the end of the PATH of its Claude Code sessions, so a project's own `python`, `pip` and `pytest` come first. Run
it again to upgrade them. `npm audit` comes with Node.js.

## Run with Docker

```bash
cp .env.example .env     # optional
docker compose up -d --build
docker compose logs pae | grep "setup token"
docker compose exec -it pae pae claude-login   # sign the platform's Claude Code in to your subscription
```

The container listens on 127.0.0.1:8600 only. Data lives in the `pae-data`
volume (`/data`); host projects for agents go in `PAE_WORKSPACES_HOST_DIR`
(mounted at `/workspaces`).

## AI access: subscriptions, never API keys

Team members run on Claude Code signed in to your own Claude subscription, or on any agent that speaks the
Agent Client Protocol (Gemini CLI, Codex, GitHub Copilot, Cursor...) on its own sign-in. There is no API key, no
pay-per-token provider and no paid fallback; see [subscription-architecture.md](subscription-architecture.md) for the design and its limits.

1. Sign in once: `cd backend && .venv/Scripts/pae claude-login`. Claude Code's own sign-in
   opens in your browser; the platform never sees the credential. Check with `pae claude-status`.
2. Keep usage credits turned off in claude.ai Settings > Usage.
3. Settings > Providers shows the sign-in state and any usage-limit block.

| Provider | What it is |
|---|---|
| `claude-code` (default) | Claude Code on your subscription. The CLI ships inside the `claude-agent-sdk` package; its sign-in lives in `<data>/claude-home` |
| `acp:<id>` | An ACP agent on its own sign-in (`gemini`, `codex`, `copilot`, `cursor`, `goose`, `opencode`, `qwen`, `mistral-vibe`, or one added in the setting `engines.agents`). Install it and sign in once in the agent itself; Tools & Connections shows what is installed |
| `scripted` | Deterministic test provider, not a model. Free, used by tests and the `runtime-contracts` evals |

## Configuration

Process settings are environment variables; everything else is in Settings.

| Variable | Default | Meaning |
|---|---|---|
| `PAE_DATA_DIR` | `~/.pae` | Database, encryption key, default workspaces |
| `PAE_HOST` / `PAE_PORT` | `127.0.0.1` / `8600` | Bind address |
| `PAE_WORKSPACE_ROOTS` | `<data>/workspaces` | Directories agents may work in (OS path separator) |
| `PAE_DEFAULT_WORKSPACE` | `<data>/workspaces/default` | Workspace when a run names none |
| `PAE_SETUP_TOKEN` | random, logged | One-time owner setup token |
| `PAE_MASTER_KEY` | key file in data dir | Fernet key for secrets (overrides the file) |
| `PAE_CLAUDE_CONFIG_DIR` | `<data>/claude-home` | Claude Code home for platform sessions (holds the subscription sign-in) |
| `PAE_COOKIE_SECURE` | `false` | Set `true` behind HTTPS |
| `PAE_AGENTS_DIR`, `PAE_EVALS_DIR`, `PAE_TEMPLATES_DIR`, `PAE_FRONTEND_DIST` | repository folders | Content locations |

## Backup and restore

Everything is in `PAE_DATA_DIR`: `pae.db` (runs, events, agents, settings,
encrypted secrets), `secret.key` (needed to decrypt secrets) and `claude-home/`
(Claude Code's own sign-in for platform sessions; treat it like a password, or leave it
out of backups and sign in again after a restore).

```bash
# Backup (consistent copy while running)
sqlite3 ~/.pae/pae.db ".backup '/backups/pae-$(date +%F).db'"
cp ~/.pae/secret.key /backups/secret.key        # store separately from the database
# Docker
docker compose exec pae python -c "import sqlite3; s=sqlite3.connect('/data/pae.db'); d=sqlite3.connect('/data/backup.db'); s.backup(d)"
docker compose cp pae:/data/backup.db ./pae-backup.db
```

Restore: stop the platform, put the database and key back in the data
directory, start it. Migrations run automatically on start. Without
`secret.key`, everything restores except secret values: set them again.

Owner password lost: `pae set-password <username>` (prompts for the new password,
signs out all sessions).

## Retention

Finished run trees older than `retention.days` (default 90) are deleted every
6 hours with their events and approvals. Settings > Maintenance runs it on demand.

## Recovery behaviour

If the process stops while runs are active, they are marked `interrupted` at the
next start and their pending approvals are cancelled. **Resume** continues a
native-loop run from its last checkpoint; a pending tool call is re-checked
against the policy and re-approved if needed, never replayed blindly. Claude Code
runs restart from the beginning (their sessions are not persisted). Team runs skip
members that already completed.

## Health and troubleshooting

- `GET /api/health` (no auth) reports database status; Docker uses it as a healthcheck.
- Settings > System shows provider status, MCP servers and agent load errors.

| Symptom | Cause | Fix |
|---|---|---|
| Run fails with "not signed in" | The platform's Claude Code has no subscription login, or it expired | `pae claude-login` |
| Runs refused with "usage limit reached until …" | Claude Code reported your plan's five-hour or weekly limit | Wait for the reset (or clear the block in Settings > Providers once it has reset) |
| Provider shows "Blocked: paid credential variables present" | An `ANTHROPIC_*` or cloud-provider variable is set where the platform starts | Remove it from that environment; the platform also strips it at startup |
| Agent shows "misconfigured" | It references a tool that is not registered (e.g. an MCP server is down) | Settings > Tools & integrations |
| "workspace is outside the allowed workspace roots" | The run targets a folder not listed | Add it in Settings > Workspaces or `PAE_WORKSPACE_ROOTS` |
| Secrets show as unreadable after restore | `secret.key` missing or different | Restore the key or set the secrets again |
