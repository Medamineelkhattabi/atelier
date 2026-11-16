// Pure functions that turn the API's event list into a readable timeline.
// Nothing here creates events: items only group the events the API returned.

import type { RunEvent, RunSummary } from '../../api/types';

/** Adds `incoming` to `current`, dropping events already present (by id), keeping id order. */
export function mergeEvents(current: RunEvent[], incoming: RunEvent[]): RunEvent[] {
  if (incoming.length === 0) return current;
  const seen = new Set<number>(current.map((event) => event.id));
  const fresh: RunEvent[] = [];
  for (const event of incoming) {
    if (typeof event?.id !== 'number' || seen.has(event.id)) continue;
    seen.add(event.id);
    fresh.push(event);
  }
  if (fresh.length === 0) return current;
  const merged = current.concat(fresh);
  const lastBefore = current.length ? current[current.length - 1]!.id : Number.NEGATIVE_INFINITY;
  let ordered = fresh[0]!.id > lastBefore;
  for (let i = 1; ordered && i < fresh.length; i += 1) ordered = fresh[i]!.id > fresh[i - 1]!.id;
  if (!ordered) merged.sort((a, b) => a.id - b.id);
  return merged;
}

export interface EventItem {
  kind: 'event';
  key: string;
  event: RunEvent;
}

/** All events that share one tool_call_id: the agent's call, permission, approval, execution. */
export interface ToolItem {
  kind: 'tool';
  key: string;
  toolCallId: string;
  tool: string;
  events: RunEvent[];
}

export type TimelineItem = EventItem | ToolItem;

export interface TimelineGroup {
  key: string;
  step: number | null;
  label: string;
  /** The step.started event that opened this group, rendered as the group header. */
  stepEvent?: RunEvent;
  items: TimelineItem[];
}

const OUTCOME_TYPES = new Set(['run.completed', 'run.failed', 'run.cancelled', 'run.interrupted']);

function str(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

export function buildTimeline(events: RunEvent[]): TimelineGroup[] {
  const hasSteps = events.some((event) => event.type === 'step.started');
  const first: TimelineGroup = { key: 'start', step: null, label: hasSteps ? 'Start' : 'Activity', items: [] };
  const groups: TimelineGroup[] = [first];
  let current = first;
  const cards = new Map<string, ToolItem>();
  const approvalCall = new Map<string, string>();

  for (const event of events) {
    if (event.type === 'step.started') {
      const step = typeof event.data.step === 'number' ? event.data.step : null;
      current = { key: `step-${event.id}`, step, label: step !== null ? `Step ${step}` : 'Step', stepEvent: event, items: [] };
      groups.push(current);
      continue;
    }
    if (OUTCOME_TYPES.has(event.type) && current.step !== null) {
      current = { key: `outcome-${event.id}`, step: null, label: 'Outcome', items: [] };
      groups.push(current);
    }

    const approvalId = str(event.data.approval_id);
    let callId = str(event.data.tool_call_id);
    if (event.type === 'approval.requested' && approvalId && callId) approvalCall.set(approvalId, callId);
    if (!callId && event.type === 'approval.decided' && approvalId) callId = approvalCall.get(approvalId) ?? null;

    if (callId) {
      const key = `${event.run_id}:${callId}`;
      const existing = cards.get(key);
      if (existing) {
        existing.events.push(event);
        if (!existing.tool && str(event.data.tool)) existing.tool = str(event.data.tool)!;
      } else {
        const card: ToolItem = { kind: 'tool', key, toolCallId: callId, tool: str(event.data.tool) ?? '', events: [event] };
        cards.set(key, card);
        current.items.push(card);
      }
      continue;
    }
    current.items.push({ kind: 'event', key: `e${event.id}`, event });
  }
  return groups.filter((group) => group.items.length > 0 || group.stepEvent);
}

export type ToolCardState = 'proposed' | 'approved' | 'awaiting_approval' | 'denied' | 'not_approved' | 'running' | 'completed' | 'failed';

/** The state shown on a tool card, read from the latest relevant event in the group. */
export function toolCardState(item: ToolItem): ToolCardState {
  let state: ToolCardState = 'proposed';
  for (const event of item.events) {
    switch (event.type) {
      case 'tool.permission':
        if (event.data.decision === 'deny') state = 'denied';
        break;
      case 'approval.requested':
        state = 'awaiting_approval';
        break;
      case 'approval.decided':
        state = event.data.decision === 'approved' ? 'approved' : 'not_approved';
        break;
      case 'tool.started':
        state = 'running';
        break;
      case 'tool.completed':
        state = 'completed';
        break;
      case 'tool.failed':
        state = 'failed';
        break;
      default:
        break;
    }
  }
  return state;
}

export interface RunSection {
  runId: string;
  run: RunSummary | null;
  depth: number;
  groups: TimelineGroup[];
  eventCount: number;
}

/** Whole-tree view: one section per run, in tree order (parents before children). */
export function buildTreeSections(events: RunEvent[], tree: RunSummary[]): RunSection[] {
  const byRun = new Map<string, RunEvent[]>();
  for (const event of events) {
    const list = byRun.get(event.run_id);
    if (list) list.push(event);
    else byRun.set(event.run_id, [event]);
  }
  const ordered = orderTree(tree);
  const sections: RunSection[] = ordered.map(({ run, depth }) => {
    const list = byRun.get(run.id) ?? [];
    byRun.delete(run.id);
    return { runId: run.id, run, depth, groups: buildTimeline(list), eventCount: list.length };
  });
  // Runs that appeared in the stream before the run detail was refreshed.
  for (const [runId, list] of byRun) {
    sections.push({ runId, run: null, depth: 1, groups: buildTimeline(list), eventCount: list.length });
  }
  return sections;
}

export interface TreeNode {
  run: RunSummary;
  depth: number;
}

/** Depth-first order of a run tree (roots first, children in creation order). */
export function orderTree(tree: RunSummary[]): TreeNode[] {
  const ids = new Set(tree.map((run) => run.id));
  const children = new Map<string | null, RunSummary[]>();
  for (const run of tree) {
    const parent = run.parent_run_id && ids.has(run.parent_run_id) ? run.parent_run_id : null;
    const list = children.get(parent);
    if (list) list.push(run);
    else children.set(parent, [run]);
  }
  const out: TreeNode[] = [];
  const visit = (parent: string | null, depth: number) => {
    for (const run of children.get(parent) ?? []) {
      out.push({ run, depth });
      visit(run.id, depth + 1);
    }
  };
  visit(null, 0);
  return out;
}
