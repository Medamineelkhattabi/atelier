import type { Agent, AgentDefinition } from '../api/types';

export const DEFINITION_KEYS: (keyof AgentDefinition)[] = [
  'id',
  'name',
  'version',
  'description',
  'purpose',
  'capabilities',
  'provider',
  'model',
  'effort',
  'instructions',
  'tools',
  'claude_code_tools',
  'delegates',
  'permissions',
  'limits',
  'output_schema',
  'input_hint',
  'tags',
];

/** The editable definition part of an agent view (drops stats, status, overrides...). */
export function definitionOf(agent: Agent): AgentDefinition {
  const out: Record<string, unknown> = {};
  for (const key of DEFINITION_KEYS) out[key] = agent[key];
  return out as unknown as AgentDefinition;
}

/** Per-agent limits the runtime understands (see backend settings_store DEFAULTS, limits.*). */
export const AGENT_LIMIT_KEYS: { key: string; label: string; float?: boolean }[] = [
  { key: 'max_steps', label: 'Max steps' },
  { key: 'timeout_s', label: 'Timeout (s)' },
  { key: 'max_tokens', label: 'Max tokens' },
  { key: 'max_cost_usd', label: 'Max cost (USD)', float: true },
  { key: 'max_output_tokens', label: 'Max output tokens / call' },
  { key: 'provider_retries', label: 'Provider retries' },
  { key: 'approval_timeout_s', label: 'Approval timeout (s)' },
  { key: 'tool_output_chars', label: 'Tool output chars' },
  { key: 'max_children_per_run', label: 'Max delegated runs' },
];

/** Fields every agent's structured output shares (the common envelope). */
export const ENVELOPE_FIELDS = ['status', 'summary', 'issues'] as const;

export interface ContractField {
  name: string;
  type: string;
  description: string;
  required: boolean;
  /** Part of the shared envelope (status / summary / issues). */
  envelope: boolean;
}

function typeOf(schema: Record<string, unknown>): string {
  if (Array.isArray(schema.enum)) return schema.enum.map((v) => JSON.stringify(v)).join(' | ');
  const type = schema.type;
  if (type === 'array') {
    const items = schema.items as Record<string, unknown> | undefined;
    return `${items && typeof items === 'object' ? typeOf(items) : 'any'}[]`;
  }
  if (Array.isArray(type)) return type.join(' | ');
  return typeof type === 'string' ? type : 'any';
}

/** The fields of an output schema, envelope first, in plain terms. Empty when there is no schema. */
export function outputContract(schema: Record<string, unknown> | null | undefined): ContractField[] {
  if (!schema || typeof schema !== 'object') return [];
  const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
  if (!properties || typeof properties !== 'object') return [];
  const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
  const fields = Object.entries(properties).map(([name, prop]) => ({
    name,
    type: prop && typeof prop === 'object' ? typeOf(prop) : 'any',
    description: prop && typeof prop.description === 'string' ? prop.description : '',
    required: required.has(name),
    envelope: (ENVELOPE_FIELDS as readonly string[]).includes(name),
  }));
  return [...fields.filter((f) => f.envelope), ...fields.filter((f) => !f.envelope)];
}

export const NEW_AGENT_TEMPLATE: Partial<AgentDefinition> = {
  id: 'my-agent',
  name: 'My agent',
  version: '1.0.0',
  description: 'What this agent does, in one sentence.',
  purpose: '',
  capabilities: [],
  provider: 'default',
  model: null,
  effort: null,
  instructions: 'You are ... Do ... Never ...',
  tools: ['fs_list', 'fs_read'],
  claude_code_tools: [],
  delegates: [],
  permissions: {},
  limits: {},
  output_schema: null,
  input_hint: '',
  tags: ['custom'],
};
