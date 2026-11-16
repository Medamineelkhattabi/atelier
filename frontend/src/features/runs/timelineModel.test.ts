import { describe, expect, it } from 'vitest';
import type { RunSummary } from '../../api/types';
import { event } from '../../test/utils';
import { buildTimeline, buildTreeSections, mergeEvents, orderTree, toolCardState, type ToolItem } from './timelineModel';

describe('mergeEvents (live stream dedupe)', () => {
  it('drops events already received and keeps id order', () => {
    const a = event('run.started', 'runtime');
    const b = event('step.started', 'runtime', { step: 1 });
    const c = event('agent.message', 'agent', { text: 'hi' });
    const first = mergeEvents([], [a, b]);
    // A reconnect replays b and adds c; an out-of-order duplicate of a arrives too.
    const second = mergeEvents(first, [b, c, a]);
    expect(second.map((e) => e.id)).toEqual([a.id, b.id, c.id]);
  });

  it('sorts when events arrive out of order', () => {
    const a = event('run.started', 'runtime');
    const b = event('step.started', 'runtime', { step: 1 });
    expect(mergeEvents([b], [a]).map((e) => e.id)).toEqual([a.id, b.id]);
  });

  it('returns the same array when nothing is new (no re-render)', () => {
    const a = event('run.started', 'runtime');
    const current = [a];
    expect(mergeEvents(current, [a])).toBe(current);
  });
});

describe('buildTimeline', () => {
  it('groups events by step and gathers a tool call into one card', () => {
    const events = [
      event('run.started', 'runtime'),
      event('step.started', 'runtime', { step: 1 }),
      event('agent.tool_call', 'agent', { tool_call_id: 'c1', tool: 'fs_write', input: { path: 'a' } }),
      event('tool.permission', 'runtime', { tool_call_id: 'c1', tool: 'fs_write', decision: 'ask', rule: 'default' }),
      event('approval.requested', 'runtime', { approval_id: 'ap1', tool_call_id: 'c1', tool: 'fs_write' }),
      event('approval.decided', 'user', { approval_id: 'ap1', decision: 'approved' }),
      event('tool.started', 'tool', { tool_call_id: 'c1', tool: 'fs_write' }),
      event('tool.completed', 'tool', { tool_call_id: 'c1', tool: 'fs_write', duration_ms: 12 }),
      event('step.started', 'runtime', { step: 2 }),
      event('agent.final', 'agent', { output_text: 'done' }),
      event('run.completed', 'runtime', {}),
    ];
    const groups = buildTimeline(events);
    expect(groups.map((g) => g.label)).toEqual(['Start', 'Step 1', 'Step 2', 'Outcome']);
    const card = groups[1]!.items[0] as ToolItem;
    expect(card.kind).toBe('tool');
    expect(card.tool).toBe('fs_write');
    expect(card.events.map((e) => e.type)).toEqual([
      'agent.tool_call',
      'tool.permission',
      'approval.requested',
      'approval.decided',
      'tool.started',
      'tool.completed',
    ]);
    expect(toolCardState(card)).toBe('completed');
    // Every input event is rendered exactly once.
    const rendered = groups.flatMap((g) => [...(g.stepEvent ? [g.stepEvent] : []), ...g.items.flatMap((i) => (i.kind === 'tool' ? i.events : [i.event]))]);
    expect(rendered).toHaveLength(events.length);
  });

  it('labels a run without steps (team coordination) as Activity', () => {
    const groups = buildTimeline([event('run.started', 'runtime'), event('team.member_started', 'runtime', { agent: 'a' })]);
    expect(groups.map((g) => g.label)).toEqual(['Activity']);
  });

  it('marks a denied tool call', () => {
    const groups = buildTimeline([
      event('step.started', 'runtime', { step: 1 }),
      event('agent.tool_call', 'agent', { tool_call_id: 'x', tool: 'shell_run' }),
      event('tool.permission', 'runtime', { tool_call_id: 'x', tool: 'shell_run', decision: 'deny', rule: 'global' }),
    ]);
    expect(toolCardState(groups[0]!.items[0] as ToolItem)).toBe('denied');
  });
});

describe('run tree', () => {
  const run = (id: string, parent: string | null): RunSummary =>
    ({ id, parent_run_id: parent, root_run_id: 'root', kind: 'agent', agent_id: id, status: 'completed' }) as RunSummary;

  it('orders parents before children', () => {
    const tree = [run('root', null), run('b', 'root'), run('a1', 'a'), run('a', 'root')];
    expect(orderTree(tree).map((n) => `${n.run.id}:${n.depth}`)).toEqual(['root:0', 'b:1', 'a:1', 'a1:2']);
  });

  it('builds one section per run and keeps unknown runs', () => {
    const sections = buildTreeSections(
      [event('run.started', 'runtime', {}, { run_id: 'root' }), event('run.started', 'runtime', {}, { run_id: 'new-child' })],
      [run('root', null)],
    );
    expect(sections.map((s) => [s.runId, s.eventCount])).toEqual([
      ['root', 1],
      ['new-child', 1],
    ]);
  });
});
