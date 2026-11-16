// Test data for Home, My Work, Approvals and Settings tests (API-shaped objects, nothing invented at runtime).

import type { Agent, Approval, Project, ProviderStatus, RunSummary } from '../../api/types';

export function agent(id: string, name: string, extra: Partial<Agent> = {}): Agent {
  return {
    id,
    name,
    version: '1.0.0',
    description: `${name} description`,
    purpose: '',
    capabilities: [],
    provider: 'default',
    model: null,
    effort: null,
    instructions: '',
    tools: [],
    claude_code_tools: [],
    delegates: [],
    permissions: {},
    limits: {},
    output_schema: null,
    input_hint: '',
    tags: [],
    responsibility: `${name} responsibility.`,
    tools_detail: [],
    effective_provider: 'claude-code',
    effective_model: null,
    status: 'ready',
    source: 'file',
    enabled: true,
    overrides: {},
    revision: 'r1',
    updated_at: null,
    problems: [],
    stats: {},
    ...extra,
  };
}

export const AGENTS: Agent[] = [
  agent('orchestrator', 'Coordinator'),
  agent('research', 'Researcher'),
  agent('planning', 'Planner'),
  agent('evaluator', 'Grader'),
  agent('data', 'Data Analyst', { enabled: false, status: 'disabled' }),
];

export function project(id: string, name: string): Project {
  return {
    id,
    name,
    description: '',
    workspace: `C:\\data\\workspaces\\${id}`,
    context: '',
    tags: [],
    archived: false,
    created_at: '2026-11-01T10:00:00+00:00',
    updated_at: '2026-11-01T10:00:00+00:00',
    stats: { runs: 0, active: 0, last_run_at: null },
  };
}

export function run(id: string, task: string, extra: Partial<RunSummary> = {}): RunSummary {
  return {
    id,
    kind: 'agent',
    agent_id: 'research',
    team_id: null,
    parent_run_id: null,
    root_run_id: id,
    role: null,
    status: 'completed',
    task,
    provider: 'claude-code',
    model: null,
    agent_version: '1.0.0',
    steps: 1,
    tool_calls: 0,
    input_tokens: 10,
    output_tokens: 5,
    cost_usd: 0,
    error: null,
    created_at: '2026-11-11T10:00:00+00:00',
    started_at: '2026-11-11T10:00:00+00:00',
    finished_at: '2026-11-11T10:02:05+00:00',
    duration_s: 125,
    team_name: null,
    project_id: null,
    ...extra,
  };
}

export function approval(id: string, extra: Partial<Approval> = {}): Approval {
  return {
    id,
    run_id: 'run-child',
    root_run_id: 'run-root',
    agent_id: 'research',
    tool: 'web_fetch',
    tool_call_id: 'c1',
    args: { url: 'https://example.org/prices' },
    risk: 'external',
    reason: 'Check the current prices',
    status: 'pending',
    note: null,
    created_at: '2026-11-11T10:00:00+00:00',
    decided_at: null,
    expires_at: '2099-01-01T00:00:00+00:00',
    run_task: 'Compare tools\n\n## Input\n{"x": 1}',
    project_id: null,
    ...extra,
  };
}

export function claudeProvider(extra: Partial<ProviderStatus> = {}): ProviderStatus {
  return {
    name: 'claude-code',
    description: 'Claude Code on your subscription',
    default_model: null,
    is_default: true,
    configured: true,
    detail: 'Signed in with your Claude subscription (platform login).',
    cli_path: 'C:\\bin\\claude.exe',
    auth: 'login',
    config_dir: 'C:\\data\\claude-home',
    usage: {},
    ...extra,
  };
}

export const SCRIPTED: ProviderStatus = {
  name: 'scripted',
  description: 'Deterministic test provider',
  default_model: 'scripted',
  is_default: false,
  configured: true,
  detail: 'Deterministic test provider (no model).',
};

export const SIGNED_OUT = claudeProvider({
  configured: false,
  auth: 'none',
  detail: "Not signed in. Run `pae claude-login` once in a terminal and complete Anthropic's sign-in with your Claude account.",
});
