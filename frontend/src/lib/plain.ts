// Plain-language vocabulary shared by every screen.
//
// The platform speaks to people who know nothing about agents, runs, providers or graphs.
// Words used everywhere:
//   task         what the owner asks for (one objective; technically a root run)
//   step         one piece of a task done by one team member (a plan task / child run)
//   team member  an agent, always shown by its name ("Researcher"), never by its id
//   approval     a sensitive action a team member asks permission for
//   project      a folder with its own brief and passwords; work never mixes between projects
// Technical words (run, execution, plan, orchestrator, provider, tool call, delegation...)
// only appear in "Technical details" / "Advanced" areas.

import type { Agent, JsonValue } from '../api/types';
import { engineName, type Tone } from './status';

// ------------------------------------------------------------------ statuses

export interface PlainStatus {
  label: string;
  tone: Tone;
  /** One sentence that says what this means for the owner. */
  hint: string;
}

const STATUS: Record<string, PlainStatus> = {
  queued: { label: 'Starting', tone: 'gray', hint: 'About to start.' },
  running: { label: 'Working', tone: 'blue', hint: 'Your team is working on it.' },
  waiting_approval: { label: 'Needs your approval', tone: 'amber', hint: 'Nothing happens until you decide.' },
  completed: { label: 'Done', tone: 'green', hint: 'Finished.' },
  failed: { label: "Couldn't finish", tone: 'red', hint: 'Something went wrong.' },
  cancelled: { label: 'Stopped', tone: 'slate', hint: 'Stopped before it finished.' },
  interrupted: { label: 'Interrupted', tone: 'slate', hint: 'The platform restarted; you can continue it.' },
  pending: { label: 'Not started yet', tone: 'gray', hint: 'Starts when the steps before it are done.' },
  retrying: { label: 'Trying again', tone: 'blue', hint: 'Trying once more.' },
  skipped: { label: 'Skipped', tone: 'slate', hint: 'An earlier step did not finish.' },
};

const PAUSED: PlainStatus = {
  label: 'Paused',
  tone: 'amber',
  hint: 'No new step starts until you resume.',
};

/** Status of a task or a step, in plain words. `paused` only applies while the task is still active. */
export function workStatus(status: string | null | undefined, options: { paused?: boolean } = {}): PlainStatus {
  const active = status === 'running' || status === 'queued' || status === 'waiting_approval';
  if (options.paused && active && status !== 'waiting_approval') return PAUSED;
  return (status && STATUS[status]) || { label: 'Unknown', tone: 'gray', hint: '' };
}

/** Filters offered on "My Work", in the order shown. `statuses` are the API statuses each one covers. */
export const WORK_FILTERS: { id: string; label: string; statuses: string[] }[] = [
  { id: 'all', label: 'All', statuses: [] },
  { id: 'active', label: 'In progress', statuses: ['queued', 'running'] },
  { id: 'approval', label: 'Needs your approval', statuses: ['waiting_approval'] },
  { id: 'done', label: 'Done', statuses: ['completed'] },
  { id: 'failed', label: "Couldn't finish", statuses: ['failed', 'interrupted'] },
  { id: 'stopped', label: 'Stopped', statuses: ['cancelled'] },
];

// ------------------------------------------------------------------ team members

/** A team member's name for display: never the technical id when a name is known. */
export function memberName(agentId: string | null | undefined, agents?: Pick<Agent, 'id' | 'name'>[] | Record<string, { name?: string }>): string {
  if (!agentId) return 'Your AI team';
  if (Array.isArray(agents)) return agents.find((a) => a.id === agentId)?.name ?? humanize(agentId);
  if (agents && agents[agentId]?.name) return agents[agentId]!.name!;
  return humanize(agentId);
}

function humanize(id: string): string {
  return id.replace(/[-_]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

/** Team members that are internal to the platform and not offered as helpers. */
export const INTERNAL_AGENTS: ReadonlySet<string> = new Set(['evaluator']);

/** The team member that plans and hands work to the others. */
export const COORDINATOR_ID = 'orchestrator';

export type AbilityKind = 'read' | 'documents' | 'data' | 'files' | 'commands' | 'git' | 'web' | 'services' | 'email' | 'team' | 'connections';

export interface Ability {
  kind: AbilityKind;
  /** What it can do, in plain words. */
  text: string;
  /** True when it can change something (files, other services, messages). */
  changesThings: boolean;
  /** True when it asks you before doing it (always, or outside allowed websites). */
  asksFirst: boolean;
  /** True when you have blocked it. */
  blocked: boolean;
}

const ABILITY_TEXT: Record<AbilityKind, { text: string; changes: boolean }> = {
  read: { text: 'Reads project files', changes: false },
  documents: { text: 'Reads PDF, Word, Excel and CSV', changes: false },
  data: { text: 'Analyses spreadsheets and data', changes: false },
  files: { text: 'Creates and changes files', changes: true },
  commands: { text: 'Runs commands and scripts', changes: true },
  git: { text: 'Saves changes in Git', changes: true },
  web: { text: 'Reads web pages', changes: false },
  services: { text: 'Talks to online services', changes: true },
  email: { text: 'Sends emails', changes: true },
  team: { text: 'Hands work to teammates', changes: false },
  connections: { text: 'Uses your connections', changes: true },
};

function abilityOf(tool: string): AbilityKind | null {
  if (tool.startsWith('mcp__')) return 'connections';
  if (tool.startsWith('agent_')) return 'team';
  if (['fs_write', 'fs_delete', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(tool)) return 'files';
  if (['shell_run', 'code_run_python', 'Bash'].includes(tool)) return 'commands';
  if (tool === 'git_commit') return 'git';
  if (tool.startsWith('doc_')) return 'documents';
  if (tool.startsWith('data_') || tool === 'sql_query') return 'data';
  if (tool === 'web_fetch' || tool === 'WebFetch' || tool === 'WebSearch') return 'web';
  if (tool === 'http_request' || tool === 'webhook_send') return 'services';
  if (tool === 'email_send') return 'email';
  if (tool.startsWith('fs_') || tool.startsWith('git_') || ['Read', 'Glob', 'Grep', 'LS'].includes(tool)) return 'read';
  return null;
}

/**
 * What a team member can do, derived from its real tools and their effective permissions.
 * Abilities that change things come last. Claude Code's own editing and command tools always ask first.
 */
export function agentAbilities(agent: Pick<Agent, 'tools' | 'claude_code_tools' | 'tools_detail'>): Ability[] {
  const byKind = new Map<AbilityKind, Ability>();
  const permissionOf = new Map((agent.tools_detail ?? []).map((t) => [t.name, t.permission]));
  const add = (tool: string, permission: string | null | undefined) => {
    const kind = abilityOf(tool);
    if (!kind) return;
    const base = ABILITY_TEXT[kind];
    const current = byKind.get(kind) ?? { kind, text: base.text, changesThings: base.changes, asksFirst: false, blocked: true };
    // An ability is blocked only if every tool behind it is denied; it asks first if any allowed tool asks.
    if (permission !== 'deny') current.blocked = false;
    if (permission === 'ask') current.asksFirst = true;
    byKind.set(kind, current);
  };
  for (const tool of agent.tools ?? []) add(tool, permissionOf.get(tool));
  for (const tool of agent.claude_code_tools ?? []) add(tool, ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash'].includes(tool) ? 'ask' : 'allow');
  const order: AbilityKind[] = ['read', 'documents', 'data', 'web', 'team', 'files', 'commands', 'git', 'services', 'email', 'connections'];
  return order.map((k) => byKind.get(k)).filter((a): a is Ability => !!a);
}

/** One line: can this team member change anything, and does it ask first? */
export function changeSummary(abilities: Ability[]): string {
  const changing = abilities.filter((a) => a.changesThings && !a.blocked);
  if (changing.length === 0) return 'Only reads: it never changes anything.';
  if (changing.every((a) => a.asksFirst)) return 'Can make changes, and always asks you first.';
  return 'Can make some changes without asking.';
}

// ------------------------------------------------------------------ actions that need approval

export interface PlainAction {
  /** Short title, e.g. "Create a file". */
  title: string;
  /** Verb phrase after "wants to", e.g. "create the file “notes.md” in the project folder". */
  phrase: string;
  /** What approving means, in one sentence. */
  effect: string;
  /** Text worth showing before deciding (file content, command, email body...). */
  preview?: string;
  /** Label for the preview. */
  previewLabel?: string;
  /** A proposed plan: its steps in order, in plain words ("1. Researcher — Collect the facts"). */
  plan?: string[];
}

/** Team member names for plain sentences: a list of agents, or id → name (or id → {name}). */
export type MemberNames = Pick<Agent, 'id' | 'name'>[] | Record<string, string | { name?: string }>;

function nameIn(agentId: string, names?: MemberNames): string {
  if (!names || Array.isArray(names)) return memberName(agentId, names);
  const entry = names[agentId];
  if (typeof entry === 'string' && entry) return entry;
  if (entry && typeof entry === 'object' && entry.name) return entry.name;
  return memberName(agentId);
}

/** The tools the Coordinator uses to propose work: the owner checks the plan before anything starts. */
export const PLAN_TOOLS: ReadonlySet<string> = new Set(['agent_run_plan', 'agent_delegate']);

/** True when an approval is a plan to check (whatever the prefix the runtime gives the tool). */
export function isPlanTool(tool: string): boolean {
  return PLAN_TOOLS.has(tool.replace(/^claude_code\./, '').replace(/^mcp__pae__/, ''));
}

/** "1. Researcher — Collect hiring constraints", "2. Technical Writer — Write the notes (after 1)". */
export function planSteps(tool: string, args: JsonValue | unknown, names?: MemberNames): string[] {
  const a = asObject(args);
  const name = tool.replace(/^claude_code\./, '').replace(/^mcp__pae__/, '');
  const label = (t: Record<string, unknown>) => {
    const title = str(t.title).trim() || str(t.task).trim().split('\n')[0]!;
    return title.length > 90 ? `${title.slice(0, 89)}…` : title;
  };
  if (name === 'agent_delegate') {
    const who = str(a.agent_id ?? a.agent);
    return [`1. ${who ? nameIn(who, names) : 'A team member'} — ${label(a)}`];
  }
  const tasks = Array.isArray(a.tasks) ? (a.tasks as unknown[]).map(asObject) : [];
  const number = new Map(tasks.map((t, i) => [str(t.id), i + 1]));
  return tasks.map((t, i) => {
    const who = str(t.agent_id ?? t.agent);
    const after = (Array.isArray(t.depends_on) ? t.depends_on : []).map((d) => number.get(str(d))).filter((n): n is number => !!n);
    return `${i + 1}. ${who ? nameIn(who, names) : 'A team member'} — ${label(t)}${after.length ? ` (after ${after.join(', ')})` : ''}`;
  });
}

const asObject = (args: JsonValue | unknown): Record<string, unknown> =>
  args && typeof args === 'object' && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
const str = (value: unknown): string => (typeof value === 'string' ? value : value === undefined || value === null ? '' : JSON.stringify(value));
const quoted = (value: unknown) => `“${str(value)}”`;

function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();
const short = (text: string, limit: number) => (text.length <= limit ? text : `${text.slice(0, limit - 1)}…`);

// ------------------------------------------------------------------ actions of ACP agents (Gemini CLI, Codex...)

/** An action of an agent that speaks the Agent Client Protocol: tool "acp.<engine id>.<kind>", e.g. "acp.gemini.execute". */
export interface AcpTool {
  engineId: string;
  /** Display name: "Gemini CLI". */
  engine: string;
  /** read, edit, delete, move, search, execute, think, fetch, switch_mode, other, or write_file. */
  kind: string;
}

export function acpTool(tool: string): AcpTool | null {
  const match = /^acp\.(.+)\.([a-z_]+)$/.exec(tool);
  return match ? { engineId: match[1]!, engine: engineName(match[1]!), kind: match[2]! } : null;
}

export interface AcpFacts {
  /** The agent's own description of the action. */
  title: string;
  path: string;
  command: string;
  url: string;
  /** New text of the file (`content`, or the diff's `newText`). */
  content: string | undefined;
  /** From the diff: a new file ("create") or an existing one ("change"); null when there is no diff. */
  change: 'create' | 'change' | null;
}

/** What an ACP agent's tool call says: `title`, `command`, `path`, `content`, `diff` {path, oldText, newText}. */
export function acpFacts(args: JsonValue | unknown): AcpFacts {
  const a = asObject(args);
  const diff = a.diff && typeof a.diff === 'object' && !Array.isArray(a.diff) ? (a.diff as Record<string, unknown>) : null;
  const title = oneLine(str(a.title));
  const url = str(a.url) || (/https?:\/\/[^\s"'”)]+/.exec(title)?.[0] ?? '');
  const content = typeof a.content === 'string' ? a.content : typeof diff?.newText === 'string' ? diff.newText : undefined;
  const change = diff ? (typeof diff.oldText === 'string' && diff.oldText !== '' ? 'change' : 'create') : null;
  return { title, path: str(a.path) || str(diff?.path), command: str(a.command), url, content, change };
}

const FILES_EFFECT = 'This changes files in your project folder.';
const READ_EFFECT = 'It only reads: nothing changes.';

function describeAcp(acp: AcpTool, args: JsonValue | unknown): PlainAction {
  const f = acpFacts(args);
  const by = ` (${acp.engine})`;
  const described = f.title ? { preview: f.title, previewLabel: 'Described as' } : {};
  const file = f.path ? `the file ${quoted(f.path)}` : 'a file';
  switch (acp.kind) {
    case 'execute':
      return {
        title: 'Run a command',
        phrase: f.command ? `run the command ${quoted(short(oneLine(f.command), 80))}${by}` : `run a command in the project folder${by}`,
        effect: 'Commands can change files or settings on this computer. Read it before approving.',
        ...(f.command ? { preview: f.command, previewLabel: 'Command' } : described),
      };
    case 'edit':
    case 'write_file': {
      const change = acp.kind === 'edit' ? 'change' : f.change;
      const content = f.content !== undefined ? { preview: f.content, previewLabel: change === 'change' ? 'New content' : 'Content' } : described;
      if (change === 'change') return { title: 'Change a file', phrase: `change ${file}${by}`, effect: FILES_EFFECT, ...content };
      if (change === 'create') return { title: 'Create a file', phrase: `create ${file} in the project folder${by}`, effect: FILES_EFFECT, ...content };
      return { title: 'Write a file', phrase: `write ${file}${by}`, effect: FILES_EFFECT, ...content };
    }
    case 'delete':
      return { title: 'Delete a file', phrase: `delete ${f.path ? quoted(f.path) : 'a file'}${by}`, effect: 'The file is removed from your project folder. This cannot be undone.', ...described };
    case 'move':
      return { title: 'Move a file', phrase: `move ${file}${by}`, effect: FILES_EFFECT, ...described };
    case 'fetch':
      return {
        title: 'Open a web page',
        phrase: f.url ? `read the web page ${f.url}${by}` : `read a web page${by}`,
        effect: f.url ? `This contacts ${hostOf(f.url)}, a site outside this computer.` : 'This contacts a site outside this computer.',
        ...described,
      };
    case 'read':
      return { title: 'Read files', phrase: f.path ? `read ${file}${by}` : `read files in the project folder${by}`, effect: READ_EFFECT, ...described };
    case 'search':
      return { title: 'Search the project', phrase: `search the project${by}`, effect: READ_EFFECT, ...described };
    default: {
      // think, switch_mode, other: the agent's own description says what it is.
      const fallback = acp.kind === 'switch_mode' ? 'change its working mode' : acp.kind === 'think' ? 'think it through' : 'use one of its tools';
      return {
        title: f.title ? short(f.title, 60) : fallback.replace(/^\w/, (c) => c.toUpperCase()),
        phrase: f.title ? `do ${quoted(short(f.title, 80))}${by}` : `${fallback}${by}`,
        effect: 'Check the technical details before approving.',
      };
    }
  }
}

/** Describe a tool call in plain words (used by approvals and the activity feed). `names`: team member names for plans. */
export function describeAction(tool: string, args: JsonValue | unknown, names?: MemberNames): PlainAction {
  const a = asObject(args);
  const name = tool.replace(/^claude_code\./, '');
  const path = str(a.path ?? a.file_path ?? a.notebook_path);
  const acp = acpTool(name);
  if (acp) return describeAcp(acp, args);
  if (isPlanTool(name)) {
    const plan = planSteps(name, args, names);
    const count = `${plan.length} step${plan.length === 1 ? '' : 's'}`;
    return {
      title: 'Check the plan',
      phrase: `start this plan (${count})`,
      effect: 'Nothing starts until you decide.',
      preview: plan.join('\n'),
      previewLabel: 'Plan',
      plan,
    };
  }
  switch (name) {
    case 'fs_write': {
      const mode = str(a.mode) || 'create';
      const phrase =
        mode === 'overwrite'
          ? `replace the contents of the file ${quoted(path)}`
          : mode === 'append'
            ? `add text to the end of the file ${quoted(path)}`
            : `create the file ${quoted(path)} in the project folder`;
      return { title: mode === 'create' ? 'Create a file' : 'Change a file', phrase, effect: 'This changes files in your project folder.', preview: str(a.content), previewLabel: 'Content' };
    }
    case 'Write':
      return { title: 'Write a file', phrase: `write the file ${quoted(path)}`, effect: 'This changes files in your project folder.', preview: str(a.content), previewLabel: 'Content' };
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return {
        title: 'Edit a file',
        phrase: `edit the file ${quoted(path)}`,
        effect: 'This changes files in your project folder.',
        preview: a.new_string !== undefined ? `Replace:\n${str(a.old_string)}\n\nWith:\n${str(a.new_string)}` : undefined,
        previewLabel: 'Change',
      };
    case 'fs_delete':
      return { title: 'Delete a file', phrase: `delete ${quoted(path)}`, effect: 'The file is removed from your project folder. This cannot be undone.' };
    case 'shell_run':
    case 'Bash':
      return {
        title: 'Run a command',
        phrase: 'run a command in the project folder',
        effect: 'Commands can change files or settings on this computer. Read it before approving.',
        preview: str(a.command),
        previewLabel: 'Command',
      };
    case 'code_run_python':
      return { title: 'Run a Python script', phrase: 'run a Python script in the project folder', effect: 'Scripts can change files on this computer. Read it before approving.', preview: str(a.code), previewLabel: 'Script' };
    case 'git_commit':
      return { title: 'Save changes in Git', phrase: `save the current changes in Git with the message ${quoted(a.message)}`, effect: 'This adds a commit to the project’s history.' };
    case 'web_fetch':
    case 'WebFetch':
      return { title: 'Open a web page', phrase: `read the web page ${str(a.url)}`, effect: `This contacts ${hostOf(str(a.url))}, a site outside this computer.` };
    case 'http_request': {
      const method = (str(a.method) || 'GET').toUpperCase();
      const url = str(a.url);
      return method === 'GET'
        ? { title: 'Fetch data from a service', phrase: `fetch data from ${url}`, effect: `This contacts ${hostOf(url)}.` }
        : { title: 'Send data to a service', phrase: `send data to ${url} (${method})`, effect: `This can change data at ${hostOf(url)}.`, preview: a.body !== undefined ? str(a.body) : undefined, previewLabel: 'Data sent' };
    }
    case 'webhook_send':
      return { title: 'Notify a service', phrase: `send a notification to ${str(a.url)}`, effect: `This sends data to ${hostOf(str(a.url))}.`, preview: a.payload !== undefined ? str(a.payload) : undefined, previewLabel: 'Data sent' };
    case 'email_send':
      return {
        title: 'Send an email',
        phrase: `send an email to ${str(Array.isArray(a.to) ? (a.to as unknown[]).join(', ') : a.to)} with the subject ${quoted(a.subject)}`,
        effect: 'The email is sent immediately and cannot be recalled.',
        preview: str(a.body),
        previewLabel: 'Message',
      };
    default:
      if (name.startsWith('mcp__')) {
        const [, server, ...rest] = name.split('__');
        return { title: 'Use a connection', phrase: `use “${rest.join('__')}” from your connection “${server}”`, effect: 'This uses an external tool you connected.' };
      }
      return { title: 'Use a tool', phrase: `use the tool “${name}”`, effect: 'Check the technical details before approving.' };
  }
}

// ------------------------------------------------------------------ task text and reports

/** The owner's words of a task, without the context the platform appends for agents. */
export function plainTaskText(task: string | null | undefined): string {
  if (!task) return '';
  return task.split(/\n\n## (?:Results handed off|Previous attempt failed|Input\b|Earlier task this continues|What to review)/)[0]!.trim();
}

// ------------------------------------------------------------------ security reviews

/** What a security review decided, in the owner's words. */
export const VERDICT_LABEL: Record<'pass' | 'pass_with_warnings' | 'block', PlainStatus> = {
  block: { label: 'Blocks the change', tone: 'red', hint: 'The change could cause a breach as it is. Fix what blocks before using it.' },
  pass_with_warnings: { label: 'Passed with warnings', tone: 'amber', hint: 'Nothing blocks the change; some points are worth fixing.' },
  pass: { label: 'Nothing blocks', tone: 'green', hint: 'The review found nothing that blocks the change.' },
};

/** The verdict of a security review's report; null for any other report. */
export function verdictOf(output: unknown): keyof typeof VERDICT_LABEL | null {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return null;
  const verdict = (output as Record<string, unknown>).verdict;
  return verdict === 'pass' || verdict === 'pass_with_warnings' || verdict === 'block' ? verdict : null;
}

export interface Finding {
  severity: string;
  /** "app/export.py:12", or the file alone. */
  where: string;
  issue: string;
  exploit: string;
  fix: string;
}

const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low'];
const severityRank = (severity: string) => (SEVERITY_ORDER.includes(severity) ? SEVERITY_ORDER.indexOf(severity) : SEVERITY_ORDER.length);

/** The findings of a security review, most severe first. */
export function findingsOf(output: unknown): Finding[] {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return [];
  const list = (output as Record<string, unknown>).findings;
  if (!Array.isArray(list)) return [];
  return list
    .filter((f): f is Record<string, unknown> => !!f && typeof f === 'object' && !Array.isArray(f))
    .map((f) => ({
      severity: str(f.severity).toLowerCase(),
      where: [str(f.file), typeof f.line === 'number' && f.line > 0 ? String(f.line) : ''].filter(Boolean).join(':'),
      issue: str(f.issue),
      exploit: str(f.exploit),
      fix: str(f.fix),
    }))
    .filter((f) => f.issue)
    .sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
}

// ------------------------------------------------------------------ code changes

export interface ChangeFacts {
  files: string[];
  /** The check the team member ran on its change, when it reported one. */
  check: { command: string; result: string; passed: boolean } | null;
}

/** What a coding team member reports about its change: the files it changed and the check it ran. */
export function changeFactsOf(output: unknown): ChangeFacts | null {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return null;
  const o = output as Record<string, unknown>;
  if (!Array.isArray(o.files_changed)) return null;
  const files = o.files_changed.map((f) => str(f)).filter(Boolean);
  const v = o.verification && typeof o.verification === 'object' && !Array.isArray(o.verification) ? (o.verification as Record<string, unknown>) : null;
  const check = v && typeof v.passed === 'boolean' ? { command: str(v.command), result: str(v.result), passed: v.passed } : null;
  return files.length > 0 || check ? { files, check } : null;
}

export interface PlainReport {
  /** complete / partial / blocked, when the team member reported it. */
  outcome: 'complete' | 'partial' | 'blocked' | null;
  /** One or two sentences. */
  summary: string;
  /** The main answer when the report has one (e.g. the Coordinator's `result`). */
  answer: string;
  /** Gaps and problems the team member reported. */
  issues: string[];
  /** Everything else, for "Show the full result". */
  details: Record<string, unknown> | null;
}

export const OUTCOME_LABEL: Record<'complete' | 'partial' | 'blocked', PlainStatus> = {
  complete: { label: 'Fully done', tone: 'green', hint: 'Fully handled, says the team.' },
  partial: { label: 'Partly done', tone: 'amber', hint: 'Some of it could not be done.' },
  blocked: { label: 'Could not be done', tone: 'red', hint: 'Something prevented the work.' },
};

/** Read a team member's report (structured output or plain text) into plain parts. */
export function readReport(output: unknown, outputText?: string | null): PlainReport {
  if (output && typeof output === 'object' && !Array.isArray(output)) {
    const o = output as Record<string, unknown>;
    const outcome = o.status === 'complete' || o.status === 'partial' || o.status === 'blocked' ? o.status : null;
    const issues = Array.isArray(o.issues) ? o.issues.map((i) => str(i)).filter(Boolean) : [];
    const answer =
      typeof o.result === 'string' ? o.result : typeof o.answer === 'string' ? o.answer : typeof o.content === 'string' ? o.content : '';
    const summary = typeof o.summary === 'string' ? o.summary : typeof o.reasoning === 'string' ? o.reasoning : '';
    const rest = Object.fromEntries(Object.entries(o).filter(([k]) => !['status', 'summary', 'issues', 'result', 'content'].includes(k)));
    return { outcome, summary, answer, issues, details: Object.keys(rest).length ? rest : null };
  }
  const text = typeof output === 'string' ? output : outputText ?? '';
  return { outcome: null, summary: '', answer: text, issues: [], details: null };
}

// ------------------------------------------------------------------ suggested activities (Home)

export interface Suggestion {
  id: string;
  title: string;
  description: string;
  /** The team member that does it; null lets the Coordinator decide and split the work. */
  agentId: string | null;
  /** Pre-filled request. Text in [brackets] is for the owner to replace. */
  template: string;
}

export const SUGGESTIONS: Suggestion[] = [
  { id: 'research', title: 'Research a topic', description: 'Facts with sources.', agentId: 'research', template: 'Find out [what you want to know] and give me the key facts with their sources.' },
  { id: 'plan', title: 'Plan a project', description: 'Steps, risks, open questions.', agentId: 'planning', template: 'Break down [your goal] into clear steps, with the risks and the open questions.' },
  { id: 'build', title: 'Build or change something', description: 'Built, tested and reviewed.', agentId: null, template: 'Add [the feature or change] to the project, then test it and review it.' },
  { id: 'fix', title: 'Fix a problem', description: 'Finds the cause and fixes it.', agentId: 'debugging', template: '[Describe what goes wrong, with the error message if there is one]. Find the cause and fix it.' },
  { id: 'review', title: 'Review code', description: 'Bugs and security problems.', agentId: 'code-review', template: 'Review [which files, or the latest changes] for bugs and security problems.' },
  { id: 'docs', title: 'Write documentation', description: 'READMEs, guides and notes.', agentId: 'documentation', template: 'Write [a README, a guide…] that explains [what].' },
  { id: 'extract', title: 'Extract data from documents', description: 'Fields from PDF, Word or Excel.', agentId: 'document-processing', template: 'Extract [which fields] from the [invoices, contracts…] in the project folder.' },
  { id: 'analyse', title: 'Analyse a spreadsheet', description: 'Exact numbers, data problems.', agentId: 'data', template: 'In [file name], find [what you want to know].' },
  { id: 'automate', title: 'Automate a process', description: 'Asks before sending anything.', agentId: 'automation', template: '[Describe the process to automate]. Ask me before sending anything.' },
];
