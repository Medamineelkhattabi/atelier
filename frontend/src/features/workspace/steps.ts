// The "Steps" view model: the task's plan tasks as plain steps, ordered by dependencies, with the
// hand-offs each one really received, what it still waits for, its nested steps and its result.
// Built only from the graph (GET /api/runs/{id}/graph) and the task's events: nothing is invented.
// A task that was never split (one team member) becomes one step derived from the root run.

import type { ApprovalGraphNode, ExecutionGraph, RootGraphNode, RunEvent, TaskGraphNode } from '../../api/types';
import { memberName, readReport, type PlainReport } from '../../lib/plain';

/** Team member names by id (graph agent table merged with the agents API). */
export type Names = Record<string, { name?: string }>;

export interface StepLink {
  stepId: string;
  agentId: string;
  name: string;
  title: string;
}

export interface Received extends StepLink {
  /** The sender's own summary of what it passed on (empty when it gave none). */
  summary: string;
}

export interface Step {
  /** Graph node id (the root node id for a task done by one team member). */
  id: string;
  node: TaskGraphNode | null;
  agentId: string | null;
  name: string;
  title: string;
  /** Task status (pending, running, waiting_approval, retrying, completed, failed, skipped, cancelled) or, for a
   * one-member task, the root run status. */
  status: string;
  /** 0 for the task's own steps, 1 for steps a team member split its work into, and so on. */
  level: number;
  received: Received[];
  /** Prerequisites that have not completed yet (only while the step has not started). */
  waitingFor: StepLink[];
  attempts: number;
  error: string | null;
  durationS: number | null;
  startedAt: string | null;
  finishedAt: string | null;
  /** The latest run of this step (its result lives there). */
  runId: string | null;
  outputPreview: string | null;
  pendingApprovals: number;
  /** Steps this step's team member split its work into, in order. */
  children: Step[];
}

export interface StepCounts {
  total: number;
  completed: number;
  failed: number;
  skipped: number;
  cancelled: number;
  active: number;
}

export interface StepsModel {
  /** Top-level steps, each with its nested steps. */
  steps: Step[];
  /** Every step, in display order. */
  all: Step[];
  /** True when the task was not split: `steps` holds one step derived from the root run. */
  single: boolean;
  /** Who organised the top-level steps: a team member, or a team (agentId null). */
  planner: { agentId: string | null; name: string };
  counts: StepCounts;
}

const DONE = new Set(['completed', 'failed', 'skipped', 'cancelled']);

/** Display names: graph agent table first, then the agents API. */
export function mergeNames(graph: Pick<ExecutionGraph, 'agents'> | undefined, agents?: { id: string; name: string }[]): Names {
  const names: Names = {};
  for (const agent of agents ?? []) names[agent.id] = { name: agent.name };
  for (const [id, info] of Object.entries(graph?.agents ?? {})) if (info?.name) names[id] = { name: info.name };
  return names;
}

/** "[complete] Two constraints found" -> "Two constraints found"; raw JSON previews are not shown as text. */
export function cleanSummary(summary: string | null | undefined): string {
  const text = (summary ?? '').replace(/^\[(complete|partial|blocked)\]\s*/, '').trim();
  if (!text || text.startsWith('{') || text.startsWith('[')) return '';
  return text;
}

/** Handoff summaries from the events (the graph keeps a shorter label), keyed "fromNode->toNode". */
function handoffSummaries(events: RunEvent[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const event of events) {
    if (event.type !== 'handoff') continue;
    const plan = event.data.plan_id;
    const from = event.data.from_task_id;
    const to = event.data.to_task_id;
    if (typeof plan !== 'string' || typeof from !== 'string' || typeof to !== 'string') continue;
    out.set(`task:${plan}:${from}->task:${plan}:${to}`, typeof event.data.summary === 'string' ? event.data.summary : '');
  }
  return out;
}

/** Longest chain of prerequisites inside one group of sibling steps (0 for steps that wait for nobody). */
function dependencyDepth(tasks: TaskGraphNode[]): Map<string, number> {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const depth = new Map<string, number>();
  const visit = (id: string, seen: Set<string>): number => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    if (seen.has(id)) return 0; // cycles are refused by the backend; never loop
    seen.add(id);
    const task = byId.get(id);
    const value = task ? Math.max(0, ...task.depends_on.filter((d) => byId.has(d)).map((d) => visit(d, seen) + 1)) : 0;
    depth.set(id, value);
    return value;
  };
  for (const task of tasks) visit(task.id, new Set());
  return depth;
}

/** Sibling steps: plans in the order they were made, and inside a plan by dependency depth, then plan order. */
function orderSiblings(tasks: TaskGraphNode[], position: Map<string, number>): TaskGraphNode[] {
  const planOrder: string[] = [];
  for (const task of tasks) if (!planOrder.includes(task.plan_id)) planOrder.push(task.plan_id);
  return planOrder.flatMap((plan) => {
    const group = tasks.filter((t) => t.plan_id === plan);
    const depth = dependencyDepth(group);
    return [...group].sort((a, b) => (depth.get(a.id)! - depth.get(b.id)!) || position.get(a.id)! - position.get(b.id)!);
  });
}

function durationOf(usageSeconds: number | null | undefined, startedAt: string | null, finishedAt: string | null, now: number): number | null {
  if (usageSeconds !== null && usageSeconds !== undefined && finishedAt) return usageSeconds;
  if (!startedAt) return usageSeconds ?? null;
  const start = Date.parse(startedAt);
  if (Number.isNaN(start)) return usageSeconds ?? null;
  const end = finishedAt ? Date.parse(finishedAt) : now;
  return Math.max(0, ((Number.isNaN(end) ? now : end) - start) / 1000);
}

export function buildSteps(graph: ExecutionGraph, options: { names?: Names; events?: RunEvent[]; now?: number } = {}): StepsModel {
  const names = options.names ?? mergeNames(graph);
  const now = options.now ?? Date.now();
  const summaries = handoffSummaries(options.events ?? []);
  const root = graph.nodes.find((n): n is RootGraphNode => n.kind === 'root');
  const tasks = graph.nodes.filter((n): n is TaskGraphNode => n.kind === 'task');
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const position = new Map(tasks.map((t, i) => [t.id, i]));
  const rootId = root?.id ?? '';
  const pendingGates = graph.nodes.filter((n): n is ApprovalGraphNode => n.kind === 'approval' && n.status === 'pending');

  const planner = root?.agent_id
    ? { agentId: root.agent_id, name: memberName(root.agent_id, names) }
    : { agentId: null, name: root?.label || 'Your team' };

  const link = (task: TaskGraphNode): StepLink => ({ stepId: task.id, agentId: task.agent_id, name: memberName(task.agent_id, names), title: task.title });

  const toStep = (task: TaskGraphNode, level: number): Step => {
    const received = graph.edges
      .filter((e) => e.kind === 'handoff' && e.target === task.id && byId.has(e.source))
      .map((e) => ({ ...link(byId.get(e.source)!), summary: cleanSummary(summaries.get(`${e.source}->${e.target}`) ?? e.label) }));
    const waitingFor =
      task.status === 'pending'
        ? task.depends_on.map((d) => byId.get(d)).filter((d): d is TaskGraphNode => !!d && d.status !== 'completed').map(link)
        : [];
    const children = orderSiblings(
      tasks.filter((t) => t.parent_id === task.id),
      position,
    ).map((child) => toStep(child, level + 1));
    return {
      id: task.id,
      node: task,
      agentId: task.agent_id,
      name: memberName(task.agent_id, names),
      title: task.title,
      status: task.status,
      level,
      received,
      waitingFor,
      attempts: task.attempts,
      error: task.error,
      durationS: durationOf(task.usage?.duration_s, task.started_at, task.finished_at, now),
      startedAt: task.started_at,
      finishedAt: task.finished_at,
      runId: task.current_run_id ?? task.run_ids[task.run_ids.length - 1] ?? null,
      outputPreview: task.output_preview,
      pendingApprovals: task.pending_approvals,
      children,
    };
  };

  // Top level: tasks planned by the root, plus any whose planner is unknown (never drop a real task).
  const topLevel = tasks.filter((t) => t.parent_id === rootId || !byId.has(t.parent_id));
  let steps = orderSiblings(topLevel, position).map((t) => toStep(t, 0));
  const single = steps.length === 0;
  if (single && root) {
    steps = [
      {
        id: root.id,
        node: null,
        agentId: root.agent_id,
        name: planner.name,
        title: ['queued', 'running', 'waiting_approval'].includes(root.status) ? 'Working on your request' : 'Worked on your request',
        status: root.status,
        level: 0,
        received: [],
        waitingFor: [],
        attempts: 1,
        error: root.error,
        durationS: durationOf(root.usage?.duration_s, root.started_at, root.finished_at, now),
        startedAt: root.started_at,
        finishedAt: root.finished_at,
        runId: root.run_id,
        outputPreview: null,
        pendingApprovals: pendingGates.filter((g) => g.attached_to === root.id).length,
        children: [],
      },
    ];
  }

  const all: Step[] = [];
  const walk = (list: Step[]) => {
    for (const step of list) {
      all.push(step);
      walk(step.children);
    }
  };
  walk(steps);

  const real = single ? [] : all;
  const counts: StepCounts = {
    total: real.length,
    completed: real.filter((s) => s.status === 'completed').length,
    failed: real.filter((s) => s.status === 'failed').length,
    skipped: real.filter((s) => s.status === 'skipped').length,
    cancelled: real.filter((s) => s.status === 'cancelled').length,
    active: real.filter((s) => !DONE.has(s.status) && s.status !== 'pending').length,
  };
  return { steps, all, single, planner, counts };
}

/** "2 of 3 steps done" (with what did not get done, when something did not). */
export function progressText(counts: StepCounts): string {
  if (counts.total === 0) return '';
  const parts = [`${counts.completed} of ${counts.total} step${counts.total === 1 ? '' : 's'} done`];
  if (counts.failed) parts.push(`${counts.failed} could not be finished`);
  if (counts.skipped) parts.push(`${counts.skipped} skipped`);
  if (counts.cancelled) parts.push(`${counts.cancelled} stopped`);
  return parts.join(' · ');
}

/** Everyone involved, in order of appearance: who organises first, then each step's team member. */
export function involvedMembers(model: StepsModel): { agentId: string; name: string }[] {
  const seen = new Map<string, string>();
  if (model.planner.agentId) seen.set(model.planner.agentId, model.planner.name);
  for (const step of model.all) if (step.agentId && !seen.has(step.agentId)) seen.set(step.agentId, step.name);
  return [...seen].map(([agentId, name]) => ({ agentId, name }));
}

/** The step a run belongs to (approvals and results are attached to runs). */
export function stepOfRun(model: StepsModel, runId: string | null | undefined): Step | null {
  if (!runId) return null;
  return model.all.find((s) => s.node?.run_ids.includes(runId) || s.runId === runId) ?? null;
}

// ------------------------------------------------------------------ results and errors

/** The full output each run reported, from its `agent.final` event. */
export function finalOutputs(events: RunEvent[]): Map<string, { output: unknown; outputText: string | null }> {
  const out = new Map<string, { output: unknown; outputText: string | null }>();
  for (const event of events) {
    if (event.type !== 'agent.final') continue;
    out.set(event.run_id, {
      output: event.data.output ?? null,
      outputText: typeof event.data.output_text === 'string' ? event.data.output_text : null,
    });
  }
  return out;
}

/**
 * What a finished step reported: from its run's final output when the events have it, else from the
 * graph's preview (null when the preview is shortened JSON that cannot be read).
 */
export function stepReport(step: Pick<Step, 'runId' | 'outputPreview'>, finals: Map<string, { output: unknown; outputText: string | null }>): PlainReport | null {
  const final = step.runId ? finals.get(step.runId) : undefined;
  if (final) return readReport(final.output, final.outputText);
  const preview = step.outputPreview;
  if (!preview) return null;
  try {
    return readReport(JSON.parse(preview));
  } catch {
    const trimmed = preview.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) return null;
    return readReport(null, preview);
  }
}

/** A technical error message turned into one plain sentence. `titles` maps a plan task id to its title. */
export function plainError(error: string | null | undefined, options: { titles?: Map<string, string>; names?: Names } = {}): string | null {
  if (!error) return null;
  const text = error.trim();
  const prerequisite = /^prerequisite '([^']+)' did not complete/.exec(text);
  if (prerequisite) {
    const title = options.titles?.get(prerequisite[1]!);
    return title ? `Not done, because the step “${title}” did not finish.` : 'Not done, because an earlier step did not finish.';
  }
  if (/the plan stopped after a failure/.test(text)) return 'Not started, because another step did not finish and the work stopped there.';
  const member = /team member '([^']+)' ended with status (\w+)/.exec(text);
  if (member) return `${memberName(member[1], options.names)} could not finish their step, so the team stopped.`;
  if (/the consolidator did not complete/.test(text)) return 'The step that puts the results together did not finish.';
  if (/cancel/i.test(text)) return 'It was stopped before it finished.';
  if (/timeout|timed out/i.test(text)) return 'It took longer than the time allowed.';
  if (/max_steps/.test(text)) return 'It reached the maximum number of actions allowed for one task.';
  if (/max_tokens|max_cost_usd|max_output_tokens|cut off/.test(text)) return 'It reached the amount of work allowed for one task.';
  if (/usage limit|Subscription usage|overage/i.test(text)) return 'Your Claude plan’s usage limit was reached. You can continue once it resets.';
  if (/not signed in|claude-login|sign[- ]in/i.test(text)) return 'Claude is not connected. Sign in to Claude in Settings, then try again.';
  if (/server restart|server shutdown/i.test(text)) return 'The platform restarted while the work was in progress.';
  if (/delegation depth|limit of delegated runs|delegation_refused/i.test(text)) return 'It tried to hand out more work than the limits allow.';
  if (/did not approve|rejected/i.test(text)) return 'It could not continue without the action you rejected.';
  if (/model call failed|provider_error|Claude Code reported an error|ended without a result|no structured output/i.test(text)) {
    return 'The team member did not get a usable answer from the AI model.';
  }
  return 'Something went wrong.';
}

/** Plan task id -> title, for the steps of one plan (used by plainError). */
export function planTitles(graph: ExecutionGraph, planId: string): Map<string, string> {
  return new Map(
    graph.nodes.filter((n): n is TaskGraphNode => n.kind === 'task' && n.plan_id === planId).map((t) => [t.task_id, t.title]),
  );
}
