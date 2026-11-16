// Plain-language helpers for "My AI Team": search, filters, state of a team member, the
// owner's rules applied to its abilities, and what it hands back (from its output schema).

import type { Agent, Permission, ToolInfo } from '../../api/types';
import { COORDINATOR_ID, agentAbilities, changeSummary, type Ability } from '../../lib/plain';

// ------------------------------------------------------------------ owner rules

/** The gate's order: a "Block" anywhere wins; otherwise the owner's rule beats the team member's setting. */
export function combinePermission(owner: Permission | null | undefined, member: Permission | null | undefined): Permission | null {
  if (owner === 'deny' || member === 'deny') return 'deny';
  return owner ?? member ?? null;
}

/**
 * The team member as it will actually behave: its tools' permissions with the owner's rules
 * (Tools & Connections) applied. The agents API reports the team member layer only.
 */
export function withOwnerRules(agent: Agent, tools: ToolInfo[] | undefined): Agent {
  if (!tools || tools.length === 0) return agent;
  const owner = new Map(tools.map((t) => [t.name, t.global_permission]));
  return {
    ...agent,
    tools_detail: (agent.tools_detail ?? []).map((t) => ({ ...t, permission: combinePermission(owner.get(t.name), t.permission) })),
  };
}

/** Abilities with the owner's rules applied. */
export function memberAbilities(agent: Agent, tools?: ToolInfo[]): Ability[] {
  return agentAbilities(withOwnerRules(agent, tools));
}

/** True when the team member can change something (files, commands, other services), even after asking. */
export function canChange(abilities: Ability[]): boolean {
  return abilities.some((a) => a.changesThings && !a.blocked);
}

/** The one-line "can it change anything?" answer; the Coordinator's depends on who it picks. */
export function memberChangeSummary(agentId: string, abilities: Ability[]): string {
  if (agentId === COORDINATOR_ID && !canChange(abilities)) {
    return 'It changes nothing itself: the specialists it picks ask you before anything sensitive.';
  }
  return changeSummary(abilities);
}

// ------------------------------------------------------------------ filters and search

export type TeamFilter = 'all' | 'reads' | 'changes';

export const TEAM_FILTERS: { id: TeamFilter; label: string; hint: string }[] = [
  { id: 'all', label: 'Everyone', hint: 'Show the whole team' },
  { id: 'reads', label: 'Only reads', hint: 'Team members that never change anything' },
  { id: 'changes', label: 'Can make changes', hint: 'Team members that can change files or contact other services' },
];

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'you', 'your', 'want', 'with', 'need', 'help', 'can', 'how', 'what', 'that', 'this', 'from', 'into',
  'about', 'some', 'any', 'are', 'was', 'its', 'our', 'out', 'who', 'why', 'get', 'please', 'make', 'have', 'has', 'not',
]);

function stem(word: string): string {
  for (const suffix of ['ing', 'es', 'ed', 's']) {
    if (word.endsWith(suffix) && word.length - suffix.length >= 3) return word.slice(0, -suffix.length);
  }
  return word;
}

/** The text a search looks at: name, what it does, when it is useful, capabilities. */
export function searchText(agent: Pick<Agent, 'name' | 'responsibility' | 'description' | 'when_to_use' | 'capabilities' | 'purpose'>): string {
  return [agent.name, agent.responsibility, agent.description, agent.purpose, ...(agent.when_to_use ?? []), ...(agent.capabilities ?? [])]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

/**
 * How well a team member matches a request ("fix a bug", "spreadsheet"): the number of meaningful
 * words found in its description. 0: no match. An empty query matches everyone (1).
 */
export function searchScore(agent: Parameters<typeof searchText>[0], query: string): number {
  const needle = query.trim().toLowerCase();
  if (!needle) return 1;
  const text = searchText(agent);
  const words = needle
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 3 && !STOP_WORDS.has(w))
    .map(stem);
  if (words.length === 0) return text.includes(needle) ? 1 : 0;
  return new Set(words.filter((w) => text.includes(w))).size;
}

/** Team members matching the request, best matches first (ties keep the original order). */
export function searchTeam<T extends Parameters<typeof searchText>[0]>(agents: T[], query: string): T[] {
  return agents
    .map((agent, index) => ({ agent, index, score: searchScore(agent, query) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.agent);
}

// ------------------------------------------------------------------ state

export interface MemberState {
  tone: 'gray' | 'red';
  title: string;
  text: string;
}

/** Why a team member cannot work right now, in plain words; null when it is ready. */
export function memberState(agent: Pick<Agent, 'enabled' | 'problems' | 'status'>): MemberState | null {
  if (!agent.enabled) {
    return {
      tone: 'gray',
      title: 'Turned off',
      text: 'Nobody can give it work while it is off: the Coordinator skips it and you cannot ask it directly.',
    };
  }
  if ((agent.problems ?? []).length > 0 || agent.status === 'misconfigured') {
    return {
      tone: 'red',
      title: 'Needs fixing',
      text: 'Something in its setup is wrong, so it cannot work until it is fixed in its advanced settings.',
    };
  }
  return null;
}

// ------------------------------------------------------------------ what you get back

type Schema = Record<string, unknown>;

const asSchema = (value: unknown): Schema | null => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Schema) : null);

function itemKeys(prop: Schema): string[] {
  const items = asSchema(prop.items);
  const source = items ?? (prop.type === 'object' ? prop : null);
  const properties = source ? asSchema(source.properties) : null;
  return properties ? Object.keys(properties) : [];
}

/** Field name → plain words. Fields that depend on their content are handled in `fieldText`. */
const FIELD_TEXT: Record<string, string> = {
  summary: 'A short summary',
  result: 'The final result',
  sources: 'The list of sources it read',
  open_questions: 'Open questions that still need an answer',
  actions: 'Each action it took, and how it went',
  scope: 'What was reviewed',
  verdict: 'An overall verdict',
  quality_issues: 'Data quality problems it found',
  files_written: 'The files it wrote',
  files_changed: 'The files it changed',
  reproduced: 'Whether it could make the problem happen again',
  root_cause: 'The cause of the problem',
  evidence: 'The evidence behind its conclusion',
  fix_summary: 'What it fixed',
  verification: 'How the result was checked',
  documents: 'The fields found in each document, with where each value came from',
  sources_read: 'What it read to write it',
  passed: 'A pass or fail decision',
  score: 'A score',
  criteria: 'A decision for each point of the checklist, explained',
  reasoning: 'Its reasoning',
  steps: 'Who did each step, and the outcome',
  validation: 'How the combined result was checked',
  objective: 'Your goal, restated clearly',
  assumptions: 'The assumptions it made',
  tasks: 'Clear steps, each with who should do it and how to tell it is done',
  risks: 'Risks, with how to reduce them',
  runs: 'The tests it ran, and their results',
  failures: 'Each failure, with its cause',
  coverage_gaps: 'What is not tested yet',
  follow_ups: 'Suggested next steps',
};

/** Shared by every answer; described once instead of per team member. */
const ENVELOPE = new Set(['status', 'issues']);

function humanizeField(name: string): string {
  const text = name.replace(/[_-]+/g, ' ').trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function fieldText(name: string, prop: Schema): string {
  if (name === 'findings') {
    const keys = itemKeys(prop);
    if (keys.includes('source_ids')) return 'Findings, each with its sources';
    if (keys.includes('file') || keys.includes('line')) return 'Problems found, each with the file and line that prove it';
    if (keys.includes('value')) return 'Results computed from your data';
    return 'Findings';
  }
  if (FIELD_TEXT[name]) return FIELD_TEXT[name]!;
  if (typeof prop.description === 'string' && prop.description.trim()) return prop.description.trim();
  return humanizeField(name);
}

/**
 * What a team member hands back, in plain words, from its output schema ("Findings, each with its
 * sources", "Open questions…"). Empty when it answers in free text.
 */
export function deliverables(schema: unknown): string[] {
  const root = asSchema(schema);
  const properties = root ? asSchema(root.properties) : null;
  if (!properties) return [];
  const out: string[] = [];
  for (const [name, value] of Object.entries(properties)) {
    if (ENVELOPE.has(name)) continue;
    const text = fieldText(name, asSchema(value) ?? {});
    if (!out.includes(text)) out.push(text);
  }
  return out;
}

/** True when the schema has the shared "status / issues" part (it then says if it fully finished). */
export function reportsOutcome(schema: unknown): boolean {
  const properties = asSchema(asSchema(schema)?.properties);
  return !!properties && 'status' in properties;
}
