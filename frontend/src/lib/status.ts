// Shared vocabulary for statuses, risks, permissions, event sources and providers,
// so colours and labels are the same on every page.

import type { EventSource_, Permission, RunStatus } from '../api/types';

export const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
export const ACTIVE_STATUSES: ReadonlySet<string> = new Set(['queued', 'running', 'waiting_approval']);

export function isActive(status: string | null | undefined): boolean {
  return !!status && ACTIVE_STATUSES.has(status);
}

export function isTerminal(status: string | null | undefined): boolean {
  return !!status && TERMINAL_STATUSES.has(status);
}

export const RUN_STATUSES: RunStatus[] = [
  'queued',
  'running',
  'waiting_approval',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
];

const STATUS_LABEL: Record<string, string> = {
  queued: 'Queued',
  running: 'Running',
  waiting_approval: 'Waiting approval',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
  interrupted: 'Interrupted',
  // agents
  ready: 'Ready',
  disabled: 'Disabled',
  misconfigured: 'Misconfigured',
  // approvals
  pending: 'Pending',
  approved: 'Approved',
  rejected: 'Rejected',
  expired: 'Expired',
  // mcp / evals
  connected: 'Connected',
  stopped: 'Stopped',
  error: 'Error',
  starting: 'Starting',
};

export function statusLabel(status: string | null | undefined): string {
  if (status === null || status === undefined || status === '') return 'Unknown';
  const text = String(status);
  return STATUS_LABEL[text] ?? text.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

type Tone = 'gray' | 'blue' | 'amber' | 'green' | 'red' | 'slate' | 'violet' | 'teal' | 'orange' | 'accent';

const STATUS_TONE: Record<string, Tone> = {
  queued: 'gray',
  running: 'blue',
  waiting_approval: 'amber',
  completed: 'green',
  failed: 'red',
  cancelled: 'slate',
  interrupted: 'slate',
  ready: 'green',
  disabled: 'slate',
  misconfigured: 'red',
  pending: 'amber',
  approved: 'green',
  rejected: 'red',
  expired: 'slate',
  connected: 'green',
  stopped: 'slate',
  error: 'red',
  starting: 'blue',
};

export function statusTone(status: string | null | undefined): Tone {
  return (status && STATUS_TONE[status]) || 'gray';
}

export const TONE_BADGE: Record<Tone, string> = {
  gray: 'bg-zinc-100 text-zinc-700 ring-zinc-300 dark:bg-zinc-800 dark:text-zinc-300 dark:ring-zinc-700',
  blue: 'bg-blue-50 text-blue-700 ring-blue-200 dark:bg-blue-950/60 dark:text-blue-300 dark:ring-blue-900',
  amber: 'bg-amber-50 text-amber-800 ring-amber-200 dark:bg-amber-950/60 dark:text-amber-300 dark:ring-amber-900',
  green: 'bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-950/60 dark:text-emerald-300 dark:ring-emerald-900',
  red: 'bg-red-50 text-red-700 ring-red-200 dark:bg-red-950/60 dark:text-red-300 dark:ring-red-900',
  slate: 'bg-slate-100 text-slate-600 ring-slate-300 dark:bg-slate-800 dark:text-slate-300 dark:ring-slate-700',
  violet: 'bg-violet-50 text-violet-700 ring-violet-200 dark:bg-violet-950/60 dark:text-violet-300 dark:ring-violet-900',
  teal: 'bg-teal-50 text-teal-700 ring-teal-200 dark:bg-teal-950/60 dark:text-teal-300 dark:ring-teal-900',
  orange: 'bg-orange-50 text-orange-700 ring-orange-200 dark:bg-orange-950/60 dark:text-orange-300 dark:ring-orange-900',
  accent: 'bg-accent-50 text-accent-700 ring-accent-200 dark:bg-accent-950/60 dark:text-accent-300 dark:ring-accent-900',
};

export const TONE_DOT: Record<Tone, string> = {
  gray: 'bg-zinc-400',
  blue: 'bg-blue-500',
  amber: 'bg-amber-500',
  green: 'bg-emerald-500',
  red: 'bg-red-500',
  slate: 'bg-slate-400',
  violet: 'bg-violet-500',
  teal: 'bg-teal-500',
  orange: 'bg-orange-500',
  accent: 'bg-accent-500',
};

export const TONE_BAR: Record<Tone, string> = TONE_DOT;

export type { Tone };

// ------------------------------------------------------------------ risk & permission

const RISK_TONE: Record<string, Tone> = {
  read: 'green',
  write: 'amber',
  external: 'blue',
  execute: 'orange',
  destructive: 'red',
};

export function riskTone(risk: string | null | undefined): Tone {
  return (risk && RISK_TONE[risk]) || 'gray';
}

/** What a risk level means, in plain language. */
const RISK_DESCRIPTION: Record<string, string> = {
  read: 'Only reads: it cannot change anything.',
  write: 'Creates or changes files in the workspace.',
  external: 'Talks to services outside this machine (network, email…).',
  execute: 'Runs commands or programs on this machine.',
  destructive: 'Can delete or overwrite data, with no undo.',
};

export function riskDescription(risk: string | null | undefined): string {
  return (risk && RISK_DESCRIPTION[risk]) || 'Risk level not declared.';
}

// ------------------------------------------------------------------ plan tasks (agent workspace)

const TASK_STATUS_TONE: Record<string, Tone> = {
  pending: 'gray',
  running: 'blue',
  waiting_approval: 'amber',
  retrying: 'orange',
  completed: 'green',
  failed: 'red',
  skipped: 'slate',
  cancelled: 'slate',
};

const TASK_STATUS_LABEL: Record<string, string> = {
  pending: 'Not started',
  running: 'Running',
  waiting_approval: 'Waiting approval',
  retrying: 'Retrying',
  completed: 'Completed',
  failed: 'Failed',
  skipped: 'Skipped',
  cancelled: 'Cancelled',
};

const TASK_STATUS_HINT: Record<string, string> = {
  pending: 'Waiting for its prerequisites or a free slot.',
  running: 'An agent is working on it now.',
  waiting_approval: 'Paused until you approve or reject a tool call.',
  retrying: 'The previous attempt failed; the platform is trying again.',
  completed: 'Finished successfully.',
  failed: 'Failed after its allowed attempts.',
  skipped: 'Not run, because a prerequisite did not complete.',
  cancelled: 'Stopped before it finished.',
};

/** Tone of a plan task status. Unlike approvals, a "pending" task is neutral: it has not started. */
export function taskStatusTone(status: string | null | undefined): Tone {
  return (status && TASK_STATUS_TONE[status]) || statusTone(status);
}

export function taskStatusLabel(status: string | null | undefined): string {
  return (status && TASK_STATUS_LABEL[status]) || statusLabel(status);
}

export function taskStatusHint(status: string | null | undefined): string {
  return (status && TASK_STATUS_HINT[status]) || '';
}

const PERMISSION_TONE: Record<Permission, Tone> = { allow: 'green', ask: 'amber', deny: 'red' };

export function permissionTone(permission: string | null | undefined): Tone {
  return (permission && PERMISSION_TONE[permission as Permission]) || 'gray';
}

// ------------------------------------------------------------------ event sources

export interface SourceStyle {
  label: string;
  description: string;
  tone: Tone;
  /** Left border / rail colour on timeline rows. */
  rail: string;
  text: string;
}

export const SOURCE_STYLE: Record<EventSource_, SourceStyle> = {
  agent: {
    label: 'Agent',
    description: 'Model action: what the agent said or decided to do',
    tone: 'violet',
    rail: 'border-violet-400 dark:border-violet-500',
    text: 'text-violet-700 dark:text-violet-300',
  },
  tool: {
    label: 'Tool',
    description: 'Observed execution: what a tool actually did',
    tone: 'teal',
    rail: 'border-teal-400 dark:border-teal-500',
    text: 'text-teal-700 dark:text-teal-300',
  },
  runtime: {
    label: 'Runtime',
    description: 'Orchestration by the platform: lifecycle, model calls, permissions, limits',
    tone: 'gray',
    rail: 'border-zinc-300 dark:border-zinc-600',
    text: 'text-zinc-600 dark:text-zinc-400',
  },
  user: {
    label: 'Owner',
    description: 'Your actions: approvals and cancellations',
    tone: 'orange',
    rail: 'border-orange-400 dark:border-orange-500',
    text: 'text-orange-700 dark:text-orange-300',
  },
};

export function sourceStyle(source: string): SourceStyle {
  return SOURCE_STYLE[source as EventSource_] ?? SOURCE_STYLE.runtime;
}

// ------------------------------------------------------------------ providers

export const SCRIPTED_LABEL = 'Scripted (test, no model)';

const PROVIDER_LABEL: Record<string, string> = {
  default: 'Platform default',
  'claude-code': 'Claude Code (subscription)',
  scripted: SCRIPTED_LABEL,
};

/** Names of the ACP agents the platform knows; an agent the owner adds is named from its id. */
const ENGINE_NAME: Record<string, string> = {
  gemini: 'Gemini CLI',
  codex: 'Codex',
  copilot: 'GitHub Copilot',
  cursor: 'Cursor',
  goose: 'goose',
  opencode: 'OpenCode',
  qwen: 'Qwen Code',
  'mistral-vibe': 'Mistral Vibe',
};

/** Display name of an ACP agent from its id ("gemini" → "Gemini CLI", "my-agent" → "My agent"). */
export function engineName(id: string): string {
  return ENGINE_NAME[id] ?? (id.replace(/[-_]+/g, ' ').trim().replace(/^\w/, (c) => c.toUpperCase()) || id);
}

export function providerLabel(name: string | null | undefined): string {
  if (!name) return '—';
  if (name.startsWith('acp:')) return engineName(name.slice(4));
  return PROVIDER_LABEL[name] ?? name;
}

/** The built-in model provider: Claude Code on the owner's Claude subscription. ACP agents come from GET /api/engines; "scripted" is a test double, offered separately. */
export const MODEL_PROVIDERS = ['claude-code'] as const;
