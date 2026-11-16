import { describe, expect, it } from 'vitest';
import type { ExecutionGraph } from '../../api/types';
import { task, workspaceGraph } from '../../test/graphFixtures';
import { LAYOUT, MAIN_LANE, layoutGraph } from './graphLayout';

const PITCH = LAYOUT.taskWidth + LAYOUT.columnGap;

function pos(graph: ExecutionGraph, id: string) {
  const node = layoutGraph(graph).byId.get(id);
  if (!node) throw new Error(`${id} not laid out`);
  return node;
}

describe('layoutGraph: layers', () => {
  it('places root, tasks by dependency depth, then the result, left to right', () => {
    const layout = layoutGraph(workspaceGraph());
    const column = (id: string) => layout.byId.get(id)!.column;
    expect(column('root')).toBe(0);
    expect(column('t-a')).toBe(1);
    expect(column('t-b')).toBe(2);
    expect(column('t-c')).toBe(2);
    expect(column('t-d')).toBe(3);
    expect(column('result')).toBe(4);
    // Columns are evenly spaced.
    expect(layout.byId.get('t-a')!.x - layout.byId.get('root')!.x).toBe(PITCH);
    expect(layout.byId.get('result')!.x - layout.byId.get('t-d')!.x).toBe(PITCH);
    // Every edge whose ends are laid out gets a path.
    expect(layout.edges).toHaveLength(11);
    for (const edge of layout.edges) expect(edge.path).toMatch(/^M [\d.-]+ [\d.-]+ C /);
  });

  it('stacks parallel branches vertically in the same column, in plan order', () => {
    const graph = workspaceGraph();
    const b = pos(graph, 't-b');
    const c = pos(graph, 't-c');
    expect(b.x).toBe(c.x);
    expect(b.row).toBe(0);
    expect(c.row).toBe(1);
    expect(c.y).toBeGreaterThanOrEqual(b.y + b.height + LAYOUT.rowGap);
  });

  it('puts a nested plan in an indented sub-lane under the task that planned it', () => {
    const layout = layoutGraph(workspaceGraph());
    expect(layout.lanes).toHaveLength(1);
    const lane = layout.lanes[0]!;
    const planner = layout.byId.get('t-b')!;
    expect(lane).toMatchObject({ parentId: 't-b', planId: 'p2', depth: 1, taskIds: ['t-b1', 't-b2'] });
    expect(lane.x).toBe(planner.x + LAYOUT.laneIndent);
    // Below everything in the main lane.
    const mainBottom = Math.max(...layout.nodes.filter((n) => n.lane === MAIN_LANE && n.kind !== 'approval').map((n) => n.y + n.height));
    expect(lane.y).toBeGreaterThan(mainBottom);
    // Parallel sub-tasks share the lane's first column and sit inside the lane box.
    const b1 = layout.byId.get('t-b1')!;
    const b2 = layout.byId.get('t-b2')!;
    expect(b1.lane).toBe(lane.id);
    expect(b1.x).toBe(b2.x);
    expect(b1.x).toBe(lane.x + LAYOUT.lanePadding);
    expect(b2.y + b2.height).toBeLessThanOrEqual(lane.y + lane.height);
    expect(layout.height).toBeGreaterThanOrEqual(lane.y + lane.height);
  });

  it('lays out a sub-plan inside a sub-plan as a deeper lane', () => {
    const graph = workspaceGraph();
    graph.nodes.push(task('t-b2x', { plan_id: 'p3', parent_id: 't-b2', title: 'Deep task' }));
    const layout = layoutGraph(graph);
    const deep = layout.lanes.find((l) => l.parentId === 't-b2')!;
    const first = layout.lanes.find((l) => l.parentId === 't-b')!;
    expect(deep.depth).toBe(2);
    expect(deep.y).toBeGreaterThanOrEqual(first.y + first.height);
    expect(deep.x).toBe(layout.byId.get('t-b2')!.x + LAYOUT.laneIndent);
  });
});

describe('layoutGraph: approval gates', () => {
  it('attaches an approval gate right under its task and reserves the space in the column', () => {
    const layout = layoutGraph(workspaceGraph());
    const host = layout.byId.get('t-c')!;
    const gate = layout.byId.get('ap-1')!;
    expect(gate.kind).toBe('approval');
    expect(gate.y).toBe(host.y + host.height + LAYOUT.approvalOffset);
    expect(gate.x).toBeGreaterThanOrEqual(host.x);
    expect(gate.x + gate.width).toBeLessThanOrEqual(host.x + host.width);
    expect(gate.column).toBe(host.column);
    const approvalEdge = layout.edges.find((e) => e.kind === 'approval')!;
    expect(approvalEdge.path.startsWith(`M ${host.x + host.width / 2} ${host.y + host.height}`)).toBe(true);
  });

  it('attaches a gate whose task is unknown to the root instead of dropping it', () => {
    const graph = workspaceGraph();
    const gate = graph.nodes.find((n) => n.id === 'ap-1')!;
    if (gate.kind === 'approval') gate.attached_to = 'missing';
    const layout = layoutGraph(graph);
    const root = layout.byId.get('root')!;
    expect(layout.byId.get('ap-1')!.y).toBe(root.y + root.height + LAYOUT.approvalOffset);
  });
});

describe('layoutGraph: robustness and determinism', () => {
  it('gives the same positions for the same graph', () => {
    const a = layoutGraph(workspaceGraph());
    const b = layoutGraph(structuredClone(workspaceGraph()));
    expect(b.nodes.map((n) => [n.id, n.x, n.y, n.width, n.height])).toEqual(a.nodes.map((n) => [n.id, n.x, n.y, n.width, n.height]));
    expect(b.edges.map((e) => e.path)).toEqual(a.edges.map((e) => e.path));
    expect([b.width, b.height]).toEqual([a.width, a.height]);
    // Fixed coordinates: a regression guard for the layout rules.
    expect(a.byId.get('root')).toMatchObject({ x: LAYOUT.padding, column: 0 });
    expect(a.byId.get('t-a')).toMatchObject({ x: LAYOUT.padding + PITCH });
  });

  it('survives dependency cycles, self-dependencies and edges to unknown nodes', () => {
    const graph: ExecutionGraph = {
      ...workspaceGraph(),
      nodes: [task('x', { depends_on: ['y', 'x'] }), task('y', { depends_on: ['x'] }), task('z', { parent_id: 'z' })],
      edges: [
        { id: 'a', source: 'x', target: 'y', kind: 'depends_on', active: false },
        { id: 'b', source: 'x', target: 'nowhere', kind: 'handoff', active: false },
      ],
    };
    const layout = layoutGraph(graph);
    expect(layout.nodes.map((n) => n.id).sort()).toEqual(['x', 'y', 'z']);
    expect(layout.edges.map((e) => e.id)).toEqual(['a']);
    expect(layout.lanes).toHaveLength(0);
  });

  it('handles a graph with only a root and a result', () => {
    const graph: ExecutionGraph = { ...workspaceGraph(), edges: [], nodes: workspaceGraph().nodes.filter((n) => n.kind === 'root' || n.kind === 'result') };
    const layout = layoutGraph(graph);
    expect(layout.byId.get('result')!.column).toBe(1);
    expect(layout.width).toBeGreaterThan(0);
  });
});
