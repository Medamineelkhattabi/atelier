// Test fixtures for the team screens: agents shaped like the agents API returns them, built from
// the same fields as agents/*.toml.

import type { Agent, AgentToolDetail, Engine, Permission, Risk, RunSummary, ToolInfo } from '../../api/types';

/** The agents a team member can run on, shaped like GET /api/engines returns them. */
export const ENGINES: Engine[] = [
  {
    id: 'claude-code',
    provider: 'claude-code',
    name: 'Claude Code',
    builtin: true,
    installed: true,
    command: '',
    install: '',
    sign_in: 'Sign in from Settings',
    plan: 'Your Claude plan',
    custom: false,
  },
  {
    id: 'gemini',
    provider: 'acp:gemini',
    name: 'Gemini CLI',
    builtin: false,
    installed: true,
    command: 'gemini --acp',
    install: 'npm install -g @google/gemini-cli',
    sign_in: 'Run `gemini` once and choose Sign in with Google',
    plan: 'Your Google account',
    custom: false,
  },
  {
    id: 'codex',
    provider: 'acp:codex',
    name: 'Codex',
    builtin: false,
    installed: false,
    command: 'codex-acp',
    install: 'npm install -g @zed-industries/codex-acp',
    sign_in: 'Run `codex login` once',
    plan: 'Your ChatGPT plan',
    custom: false,
  },
];

const TOOL_DEFAULTS: Record<string, { risk: Risk; permission: Permission; category: string }> = {
  fs_list: { risk: 'read', permission: 'allow', category: 'files' },
  fs_read: { risk: 'read', permission: 'allow', category: 'files' },
  fs_search: { risk: 'read', permission: 'allow', category: 'files' },
  fs_write: { risk: 'write', permission: 'ask', category: 'files' },
  fs_delete: { risk: 'destructive', permission: 'ask', category: 'files' },
  doc_extract_text: { risk: 'read', permission: 'allow', category: 'documents' },
  data_query: { risk: 'read', permission: 'allow', category: 'data' },
  web_fetch: { risk: 'external', permission: 'ask', category: 'web' },
  http_request: { risk: 'external', permission: 'ask', category: 'web' },
  email_send: { risk: 'external', permission: 'ask', category: 'messaging' },
  shell_run: { risk: 'execute', permission: 'ask', category: 'execution' },
  git_status: { risk: 'read', permission: 'allow', category: 'git' },
  git_commit: { risk: 'write', permission: 'ask', category: 'git' },
  agent_list: { risk: 'read', permission: 'allow', category: 'agents' },
  agent_delegate: { risk: 'read', permission: 'allow', category: 'agents' },
  agent_run_plan: { risk: 'read', permission: 'allow', category: 'agents' },
};

export function toolDetail(name: string, permission?: Permission): AgentToolDetail {
  const defaults = TOOL_DEFAULTS[name];
  return { name, available: !!defaults, risk: defaults?.risk ?? null, permission: permission ?? defaults?.permission ?? null, description: name };
}

export function toolInfo(name: string, extra: Partial<ToolInfo> = {}): ToolInfo {
  const defaults = TOOL_DEFAULTS[name] ?? { risk: 'external' as Risk, permission: 'ask' as Permission, category: 'other' };
  return {
    name,
    description: `${name} description`,
    category: defaults.category,
    risk: defaults.risk,
    default_permission: defaults.permission,
    untrusted_output: false,
    timeout_s: 60,
    input_schema: {},
    source: 'builtin',
    global_permission: null,
    used_by: [],
    ...extra,
  };
}

export function agentFor(id: string, name: string, extra: Partial<Agent> = {}): Agent {
  const tools = extra.tools ?? [];
  return {
    id,
    name,
    version: '2.0.0',
    description: '',
    purpose: '',
    capabilities: [],
    provider: 'default',
    model: null,
    effort: null,
    instructions: 'Do the job.',
    tools,
    claude_code_tools: [],
    delegates: [],
    permissions: {},
    limits: {},
    output_schema: null,
    input_hint: '',
    tags: [],
    responsibility: '',
    boundaries: [],
    works_with: [],
    when_to_use: [],
    tools_detail: tools.map((t) => toolDetail(t)),
    effective_provider: 'claude-code',
    effective_model: 'claude-sonnet',
    status: 'ready',
    source: 'file',
    enabled: true,
    overrides: {},
    revision: 'rev123',
    updated_at: null,
    problems: [],
    stats: {},
    ...extra,
  };
}

export const RESEARCH_SCHEMA = {
  type: 'object',
  required: ['status', 'summary', 'findings', 'sources', 'open_questions', 'issues'],
  properties: {
    status: { type: 'string', enum: ['complete', 'partial', 'blocked'] },
    summary: { type: 'string' },
    findings: { type: 'array', items: { type: 'object', properties: { claim: { type: 'string' }, source_ids: { type: 'array' } } } },
    sources: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' } } } },
    open_questions: { type: 'array', items: { type: 'string' } },
    issues: { type: 'array', items: { type: 'string' } },
  },
};

export const TEAM: Agent[] = [
  agentFor('research', 'Researcher', {
    responsibility: 'Answer a question with findings grounded in sources it actually read, with references.',
    when_to_use: ['You need facts with sources before deciding something', 'You want to know what is still uncertain about a topic'],
    boundaries: ['Does not write files or change anything: it only reads.'],
    works_with: ['planning', 'orchestrator'],
    tools: ['fs_list', 'fs_read', 'doc_extract_text', 'web_fetch'],
    output_schema: RESEARCH_SCHEMA,
    input_hint: 'A question or subject.',
  }),
  agentFor('planning', 'Planner', {
    responsibility: 'Turn an objective into an executable plan.',
    when_to_use: ['You have a goal and want it broken into clear steps'],
    works_with: ['orchestrator', 'research'],
    tools: ['fs_list', 'fs_read'],
  }),
  agentFor('software-engineering', 'Software Engineer', {
    responsibility: 'Implement a requested change and prove it works with tests.',
    when_to_use: ['You want a feature added or changed in a codebase'],
    works_with: ['code-review', 'research'],
    tools: ['fs_list', 'fs_read', 'fs_write', 'shell_run', 'git_status'],
    claude_code_tools: ['Read', 'Edit', 'Bash'],
  }),
  agentFor('code-review', 'Code Reviewer', {
    responsibility: 'Find real defects in code under review. Read-only.',
    when_to_use: ['You want code checked for bugs and security problems'],
    works_with: ['software-engineering'],
    tools: ['fs_list', 'fs_read', 'git_status'],
    enabled: false,
    status: 'disabled',
  }),
  agentFor('orchestrator', 'Coordinator', {
    responsibility: 'Coordinate specialist agents to reach an objective.',
    when_to_use: ['Your request needs several kinds of work'],
    works_with: ['research', 'planning', 'software-engineering', 'code-review'],
    tools: ['agent_list', 'agent_delegate', 'agent_run_plan'],
  }),
  agentFor('evaluator', 'Grader', {
    responsibility: 'Grade an output strictly against each criterion of a rubric.',
    when_to_use: ['Used by quality checks to grade another team member’s work'],
  }),
];

export function runFor(id: string, task: string, extra: Partial<RunSummary> = {}): RunSummary {
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
    agent_version: '2.0.0',
    steps: 1,
    tool_calls: 0,
    input_tokens: 0,
    output_tokens: 0,
    cost_usd: 0,
    error: null,
    created_at: '2026-11-11T10:00:00+00:00',
    started_at: '2026-11-11T10:00:00+00:00',
    finished_at: '2026-11-11T10:01:00+00:00',
    duration_s: 60,
    team_name: null,
    project_id: null,
    ...extra,
  };
}
