# Working on Atelier

Atelier runs a team of AI agents on the owner's projects (backend in `backend/pae`, web UI in `frontend/`, agent
definitions in `agents/`, eval suites in `evals/`, project templates in `templates/`). Status and evidence:
`docs/STATUS.md`. These instructions apply to any coding agent working in this repository.

## Commands
- Backend tests: `cd backend && .venv/Scripts/python -m pytest` (test doubles only, no model cost)
- Lint/format: `cd backend && .venv/Scripts/python -m ruff check pae tests && .venv/Scripts/python -m ruff format pae tests`
- Frontend: `cd frontend && npm test && npm run build`
- Run: `cd backend && .venv/Scripts/pae serve` (http://127.0.0.1:8600)
- Deterministic evals: `cd backend && .venv/Scripts/pae eval runtime-contracts`

## Hard rules
- AI access is subscriptions, never API keys: Claude Code on the user's Claude plan (`pae/subscription.py`), or an
  agent that speaks the Agent Client Protocol on its own sign-in (`pae/engines.py`, `pae/runtime/acp.py`). Never add
  an API-key provider, a pay-per-token integration or a paid fallback, and never store an agent's credentials.
- Never commit secrets. Keys come from the platform's encrypted secret store or environment variables.
- Users' projects live in their own folders. Never copy a project's code, data or credentials into this repository,
  and never name a real company, customer or person in its code, tests or docs.
- Ask first before: installing software outside the project venv/node_modules, changing global config, connecting
  external services, running live evals or other runs that use a subscription's allowance, and destructive file or
  Git operations.
- Every tool call must go through `pae/runtime/gate.py`, and every ACP agent's permission request and file access
  through the same rules (`pae/runtime/acp.py`); never add a path around them.
- Never fabricate events, metrics or results. The scripted provider and the scripted ACP agent
  (`backend/tests/fake_acp_agent.py`) are test doubles and must stay labelled.
- Report test output as it is; update `docs/STATUS.md` when a capability's status changes.

## Conventions
- Python 3.12, FastAPI, SQLAlchemy; Alembic migration for every schema change (`pae/migrations`).
- New tools: Pydantic args, `resolve_path` for paths, `ToolError` for refusals, tests in `tests/test_tools.py`.
- LF line endings (enforced by `.gitattributes`). Docs short and current.
- Commit messages and pull requests carry no AI attribution: no co-author line, no "generated with" line.
