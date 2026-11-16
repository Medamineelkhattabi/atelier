# Extending the platform

## Add an agent

Create `agents/<id>.toml` (or use My AI Team > Create a team member in the UI, then export it
as TOML). Fields:

| Field | Purpose |
|---|---|
| `id`, `name`, `version`, `description`, `purpose`, `capabilities`, `tags`, `input_hint` | Directory information |
| `responsibility`, `boundaries`, `works_with`, `when_to_use` | The contract other agents see through `agent_list`: one-sentence responsibility, what the agent does not do, which agents it usually hands work to or receives it from, plain situations where it helps. Shown on My AI Team; write them in plain words, naming other team members by name |
| `provider`, `model`, `effort` | `default` uses the platform default; `model` empty uses the provider default |
| `instructions` | The system prompt. The platform appends its non-negotiable operating rules |
| `tools` | Platform tool names the agent may call (anything else is refused) |
| `claude_code_tools` | Claude Code built-ins (`Read`, `Edit`, `Bash`...) for agents on the `claude-code` provider |
| `delegates` | Agent ids reachable through `agent_delegate` (`["*"]` for all) |
| `permissions` | Per-tool `allow` / `ask` / `deny` for this agent (`claude_code.<Tool>` for built-ins) |
| `limits` | `max_steps`, `timeout_s`, `max_tokens`, `max_cost_usd`, ... |
| `output_schema` | JSON Schema. The agent must finish with `final_answer` matching it; invalid answers are sent back to the agent with the errors |

Follow the built-in agents' output envelope so the orchestrator and the UI can read any
agent's result: `status` (`complete`, `partial`, `blocked`), `summary`, `issues` (every
gap or failure), plus the agent's own evidence fields. Say in the instructions what to do
when the task cannot be finished ("When you cannot finish"). `tests/test_agents.py`
checks these contracts for the built-in agents.

Reload with Agents > Reload (or restart). Then add eval cases for it.

## Add a tool

1. Write an async handler and a Pydantic argument model (subclass `pae.tools.base.Args`), in a module under `backend/pae/tools/`.
2. Declare it: `Tool(name, description, ArgsModel, handler, risk, default_permission, category, untrusted_output=..., timeout_s=..., dynamic_permission=...)`.
   - `risk`: read, write, external, execute, destructive. Anything that changes state outside the platform defaults to `ask`.
   - Resolve every path with `resolve_path(ctx.workspace, path)`; raise `ToolError` for refusals the model should see.
   - Mark `untrusted_output=True` when the output contains external content.
3. Add the module to `pae/tools/__init__.py` and write tests in `backend/tests/test_tools.py`.

## Connect an MCP server

Settings > Tools & integrations > MCP servers, or the `mcp.servers` setting:

```json
[{"name": "playwright", "command": "npx", "args": ["-y", "@playwright/mcp@<pinned-version>"],
  "env_secrets": {}, "enabled": true, "permission": "ask"}]
```

Pin the package version you reviewed. `env_secrets` maps environment variables
of the server process to platform secret names. On Windows use `npx.cmd`.

Its tools appear as `mcp__<server>__<tool>`, behind the same gate (default `ask`,
output treated as untrusted). Add the tool names to an agent's `tools` list.
Starting such a server may download its package: that is your decision.

## Use platform agents from another project

1. Create an API token with `POST /api/tokens` (the screen for it was removed from the UI to keep it simple).
2. In the project: `pae init . --with platform`, or add the `.mcp.json` from `templates/platform`.
3. Set `PAE_API_TOKEN` in the environment Claude Code runs in. Claude Code then has
   `list_agents`, `run_agent` and `get_run`; every run still goes through the
   platform's permissions, approvals and history.

Automation can call the HTTP API directly with `Authorization: Bearer <token>`
(`POST /api/runs`, `GET /api/runs/{id}`); OpenAPI docs at `/api/docs`.

## Providers (subscriptions, never API keys)

AI access goes through agents signed in with their user's own plan (`pae/subscription.py`):
`claude-code`, or `acp:<id>` for an agent that speaks the Agent Client Protocol. `Providers.resolve`
refuses anything else; the `scripted` test double stays for tests. See
[subscription-architecture.md](subscription-architecture.md).

## Add an AI agent (ACP)

Any agent that speaks ACP can run a team member. The catalog (`pae/engines.py`) lists the known ones with their
launch command, install command and sign-in hint, taken from the ACP registry. To add another one, or to start a
known one another way (for example through `npx`), set `engines.agents` in Settings > Advanced:

```json
{"my-agent": {"name": "My agent", "command": "my-agent", "args": ["--acp"], "plan": "Your My-agent plan"}}
```

Then pick it under **Runs on** on a team member's page. The setting holds no environment: an agent never gets an
API key from Atelier. The platform is the ACP client (`pae/runtime/acp.py`), so the agent's permission requests and
file access go through the same gate as Claude Code's tools. Tests run against a scripted ACP agent
(`backend/tests/fake_acp_agent.py`).

## Add an evaluation suite

Create `evals/<id>.toml`: `provider` (or none for each agent's own), `live`
(true when it calls a real model), and `[[cases]]` with `agent` or `team`, `task`,
optional `files` (written to a fresh workspace), `script`/`scripts` (scripted
provider), `approvals` policy, and `[cases.expect]` assertions: `status`,
`output_valid`, `tools_called`, `tools_not_called`, `tools_completed`,
`output_contains`, `output_not_contains`, `output_paths`, `error_contains`,
`max_steps`, `max_cost_usd`, `approval_requested`, `delegated_to`,
`file_exists`, `file_absent`, `file_contains`, `judge` (rubric graded by the
`evaluator` agent). Run with `pae eval <id>` (the quality checks screen was removed from the UI).

## Add a bootstrap capability

Add a folder under `templates/<name>/` (paths and text may use `{{project_name}}`
and `{{package_name}}`; JSON files written by several capabilities are merged),
then register it in `CAPABILITIES` in `backend/pae/bootstrap.py` and extend
`tests/test_bootstrap.py`.
