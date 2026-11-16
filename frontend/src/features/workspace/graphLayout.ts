// Layered left-to-right layout of an execution graph (GET /api/runs/{id}/graph).
// Pure and deterministic: the same graph always gives the same positions.
//
// - Main lane: root (column 0) → tasks of the root's plan by dependency depth → result node.
//   Tasks at the same depth are parallel branches, stacked vertically.
// - Nested plans (a task whose agent itself planned) become sub-lanes: a grouped band placed
//   below, indented under the task that planned it, laid out with the same rules.
// - Approval gates sit right under the node they belong to; the space is reserved in its column.
// Nothing here invents a node or an edge: it only positions what the API returned.

import type { ApprovalGraphNode, ExecutionGraph, GraphEdge, GraphNode, TaskGraphNode } from '../../api/types';

export const LAYOUT = {
  padding: 32,
  taskWidth: 224,
  taskHeight: 92,
  rootHeight: 100,
  resultWidth: 188,
  resultHeight: 76,
  columnGap: 76,
  rowGap: 24,
  /** Diamond size of an approval gate. */
  approvalSize: 32,
  /** Horizontal room per approval gate (diamond + tool label). */
  approvalSlot: 72,
  /** Vertical room per row of approval gates (diamond + label). */
  approvalRow: 56,
  /** Gap between a node and its approval gates. */
  approvalOffset: 14,
  laneGap: 28,
  laneHeader: 28,
  lanePadding: 16,
  laneIndent: 40,
} as const;

export const MAIN_LANE = 'main';

export interface PositionedNode {
  id: string;
  kind: GraphNode['kind'];
  node: GraphNode;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Lane of the node: MAIN_LANE for the root plan, otherwise the sub-plan's lane id. */
  lane: string;
  /** Column inside its lane (the root is column 0 of the main lane). */
  column: number;
  /** Position inside its column, 0 = top. */
  row: number;
}

/** A nested plan, drawn as a grouped band. */
export interface PositionedLane {
  id: string;
  /** The task node whose agent planned this sub-plan. */
  parentId: string;
  planId: string;
  /** 1 for a sub-plan of a main-lane task, 2 for a sub-plan inside a sub-plan... */
  depth: number;
  x: number;
  y: number;
  width: number;
  height: number;
  taskIds: string[];
}

export interface PositionedEdge extends GraphEdge {
  path: string;
  /** Point halfway along the path, for labels. */
  midX: number;
  midY: number;
}

export interface GraphLayout {
  nodes: PositionedNode[];
  byId: Map<string, PositionedNode>;
  lanes: PositionedLane[];
  edges: PositionedEdge[];
  width: number;
  height: number;
}

const L = LAYOUT;
const COLUMN_PITCH = L.taskWidth + L.columnGap;

function nodeSize(node: GraphNode): { width: number; height: number } {
  switch (node.kind) {
    case 'root':
      return { width: L.taskWidth, height: L.rootHeight };
    case 'result':
      return { width: L.resultWidth, height: L.resultHeight };
    case 'approval':
      return { width: L.approvalSize, height: L.approvalSize };
    default:
      return { width: L.taskWidth, height: L.taskHeight };
  }
}

function perRow(width: number): number {
  return Math.max(1, Math.floor(width / L.approvalSlot));
}

function approvalBlock(count: number, width: number): number {
  if (count === 0) return 0;
  return L.approvalOffset + Math.ceil(count / perRow(width)) * L.approvalRow;
}

const round = (value: number) => Math.round(value * 10) / 10;

interface Cell {
  node: GraphNode;
  width: number;
  height: number;
  /** Node height plus its approval gates. */
  cell: number;
}

export function layoutGraph(graph: Pick<ExecutionGraph, 'nodes' | 'edges'>): GraphLayout {
  // First occurrence wins if the API ever repeats an id.
  const nodes: GraphNode[] = [];
  const known = new Map<string, GraphNode>();
  for (const node of graph.nodes) {
    if (known.has(node.id)) continue;
    known.set(node.id, node);
    nodes.push(node);
  }
  const order = new Map(nodes.map((node, index) => [node.id, index]));
  const root = nodes.find((n) => n.kind === 'root') ?? null;
  const tasks = nodes.filter((n): n is TaskGraphNode => n.kind === 'task');
  const results = nodes.filter((n) => n.kind === 'result');
  const approvals = nodes.filter((n): n is ApprovalGraphNode => n.kind === 'approval');
  const taskById = new Map(tasks.map((t) => [t.id, t]));

  // ---------------------------------------------------------------- approvals per host node
  const fallbackHost = root?.id ?? tasks[0]?.id ?? results[0]?.id ?? null;
  const approvalsOf = new Map<string, ApprovalGraphNode[]>();
  for (const approval of approvals) {
    const target = known.get(approval.attached_to);
    const host = target && target.kind !== 'approval' ? target.id : fallbackHost;
    if (!host) continue;
    const list = approvalsOf.get(host);
    if (list) list.push(approval);
    else approvalsOf.set(host, [approval]);
  }

  const cellOf = (node: GraphNode): Cell => {
    const { width, height } = nodeSize(node);
    return { node, width, height, cell: height + approvalBlock(approvalsOf.get(node.id)?.length ?? 0, width) };
  };

  // ---------------------------------------------------------------- lanes (one per plan scope)
  /** The task that planned `task`, or null when it belongs to the root plan (or the chain is broken). */
  const plannerOf = (task: TaskGraphNode): string | null => {
    const parent = taskById.get(task.parent_id);
    if (!parent || parent.id === task.id) return null;
    // Guard against a cycle in the parent chain: such tasks go to the main lane.
    const seen = new Set<string>([task.id]);
    let cursor: TaskGraphNode | undefined = parent;
    while (cursor) {
      if (seen.has(cursor.id)) return null;
      seen.add(cursor.id);
      cursor = taskById.get(cursor.parent_id);
    }
    return parent.id;
  };

  const laneTasks = new Map<string, TaskGraphNode[]>([[MAIN_LANE, []]]);
  const laneMeta = new Map<string, { parentId: string; planId: string }>();
  const lanesOfParent = new Map<string, string[]>();
  for (const task of tasks) {
    const planner = plannerOf(task);
    const lane = planner ? `${planner}::${task.plan_id}` : MAIN_LANE;
    if (!laneTasks.has(lane)) {
      laneTasks.set(lane, []);
      laneMeta.set(lane, { parentId: planner!, planId: task.plan_id });
      const siblings = lanesOfParent.get(planner!);
      if (siblings) siblings.push(lane);
      else lanesOfParent.set(planner!, [lane]);
    }
    laneTasks.get(lane)!.push(task);
  }

  /** Columns of one lane: dependency depth inside the lane, ordered to limit crossings. */
  const columnsOf = (list: TaskGraphNode[]): TaskGraphNode[][] => {
    const inLane = new Set(list.map((t) => t.id));
    const depth = new Map<string, number>();
    const visiting = new Set<string>();
    const depthOf = (task: TaskGraphNode): number => {
      const cached = depth.get(task.id);
      if (cached !== undefined) return cached;
      if (visiting.has(task.id)) return 0; // cycle: ignore the back edge
      visiting.add(task.id);
      let value = 1;
      for (const dep of task.depends_on) {
        if (dep === task.id || !inLane.has(dep)) continue;
        value = Math.max(value, depthOf(taskById.get(dep)!) + 1);
      }
      visiting.delete(task.id);
      depth.set(task.id, value);
      return value;
    };
    const columns: TaskGraphNode[][] = [];
    for (const task of list) {
      const index = depthOf(task) - 1;
      while (columns.length <= index) columns.push([]);
      columns[index]!.push(task);
    }
    // Barycenter ordering: a task sits near the average position of its prerequisites.
    const rank = new Map<string, number>();
    columns.forEach((column, index) => {
      if (index > 0) {
        const key = (task: TaskGraphNode) => {
          const ranks = task.depends_on.filter((dep) => rank.has(dep)).map((dep) => rank.get(dep)!);
          return ranks.length ? ranks.reduce((a, b) => a + b, 0) / ranks.length : Number.MAX_SAFE_INTEGER;
        };
        column.sort((a, b) => key(a) - key(b) || order.get(a.id)! - order.get(b.id)!);
      }
      column.forEach((task, row) => rank.set(task.id, row));
    });
    return columns.filter((column) => column.length > 0);
  };

  const positioned = new Map<string, PositionedNode>();
  const columnHeight = (cells: Cell[]) => cells.reduce((sum, c) => sum + c.cell, 0) + L.rowGap * Math.max(0, cells.length - 1);

  /** Places columns of cells left to right from (x, top), each column centred in `contentHeight`. */
  const placeColumns = (columns: Cell[][], x: number, top: number, contentHeight: number, lane: string, firstColumn: number) => {
    columns.forEach((cells, index) => {
      let y = top + Math.round((contentHeight - columnHeight(cells)) / 2);
      const columnX = x + index * COLUMN_PITCH;
      cells.forEach((c, row) => {
        positioned.set(c.node.id, {
          id: c.node.id,
          kind: c.node.kind,
          node: c.node,
          x: columnX,
          y,
          width: c.width,
          height: c.height,
          lane,
          column: firstColumn + index,
          row,
        });
        y += c.cell + L.rowGap;
      });
    });
  };

  const displayOrder = (columns: TaskGraphNode[][]) => columns.flat().map((t) => t.id);

  // ---------------------------------------------------------------- main lane
  const mainColumns = columnsOf(laneTasks.get(MAIN_LANE)!);
  const main: Cell[][] = [];
  if (root) main.push([cellOf(root)]);
  for (const column of mainColumns) main.push(column.map(cellOf));
  if (results.length) main.push(results.map(cellOf));
  const mainHeight = main.length ? Math.max(...main.map(columnHeight)) : 0;
  placeColumns(main, L.padding, L.padding, mainHeight, MAIN_LANE, 0);

  // ---------------------------------------------------------------- sub-lanes, depth first
  const lanes: PositionedLane[] = [];
  let cursorY = L.padding + mainHeight + L.laneGap;
  const placeLanesUnder = (parentIds: string[], depth: number) => {
    for (const parentId of parentIds) {
      for (const laneId of lanesOfParent.get(parentId) ?? []) {
        const parent = positioned.get(parentId);
        if (!parent) continue;
        const columns = columnsOf(laneTasks.get(laneId)!);
        const cells = columns.map((column) => column.map(cellOf));
        const contentHeight = Math.max(...cells.map(columnHeight));
        const x = parent.x + L.laneIndent;
        const y = cursorY;
        const width = L.lanePadding * 2 + cells.length * L.taskWidth + (cells.length - 1) * L.columnGap;
        const height = L.laneHeader + L.lanePadding * 2 + contentHeight;
        placeColumns(cells, x + L.lanePadding, y + L.laneHeader + L.lanePadding, contentHeight, laneId, 0);
        const meta = laneMeta.get(laneId)!;
        lanes.push({ id: laneId, parentId: meta.parentId, planId: meta.planId, depth, x, y, width, height, taskIds: displayOrder(columns) });
        cursorY = y + height + L.laneGap;
        placeLanesUnder(displayOrder(columns), depth + 1);
      }
    }
  };
  placeLanesUnder(displayOrder(mainColumns), 1);

  // ---------------------------------------------------------------- approval gates under their host
  for (const [hostId, list] of approvalsOf) {
    const host = positioned.get(hostId);
    if (!host) continue;
    const slots = perRow(host.width);
    list.forEach((approval, index) => {
      const row = Math.floor(index / slots);
      const inRow = Math.min(slots, list.length - row * slots);
      const startX = host.x + (host.width - inRow * L.approvalSlot) / 2;
      const slot = index % slots;
      positioned.set(approval.id, {
        id: approval.id,
        kind: 'approval',
        node: approval,
        x: Math.round(startX + slot * L.approvalSlot + (L.approvalSlot - L.approvalSize) / 2),
        y: host.y + host.height + L.approvalOffset + row * L.approvalRow,
        width: L.approvalSize,
        height: L.approvalSize,
        lane: host.lane,
        column: host.column,
        row: host.row,
      });
    });
  }

  // ---------------------------------------------------------------- edges
  const edges: PositionedEdge[] = [];
  for (const edge of graph.edges) {
    const source = positioned.get(edge.source);
    const target = positioned.get(edge.target);
    if (!source || !target || source === target) continue;
    edges.push({ ...edge, ...edgePath(source, target, edge.kind) });
  }

  // ---------------------------------------------------------------- bounds and output order
  const ordered = [...positioned.values()].sort((a, b) => order.get(a.id)! - order.get(b.id)!);
  let width = 0;
  let height = 0;
  for (const n of ordered) {
    width = Math.max(width, n.x + n.width);
    // Approval labels are drawn under the diamond.
    height = Math.max(height, n.y + (n.kind === 'approval' ? L.approvalRow : n.height));
  }
  for (const lane of lanes) {
    width = Math.max(width, lane.x + lane.width);
    height = Math.max(height, lane.y + lane.height);
  }
  return {
    nodes: ordered,
    byId: new Map(ordered.map((n) => [n.id, n])),
    lanes,
    edges,
    width: Math.ceil(width + L.padding),
    height: Math.ceil(height + L.padding),
  };
}

type Point = [number, number];

function cubic(p0: Point, p1: Point, p2: Point, p3: Point): { path: string; midX: number; midY: number } {
  const f = (p: Point) => `${round(p[0])} ${round(p[1])}`;
  return {
    path: `M ${f(p0)} C ${f(p1)}, ${f(p2)}, ${f(p3)}`,
    midX: round((p0[0] + 3 * p1[0] + 3 * p2[0] + p3[0]) / 8),
    midY: round((p0[1] + 3 * p1[1] + 3 * p2[1] + p3[1]) / 8),
  };
}

/** Anchors depend on where the target is: right (same band), below (nested sub-plan), above or behind. */
export function edgePath(s: PositionedNode, t: PositionedNode, kind: GraphEdge['kind']): { path: string; midX: number; midY: number } {
  const sRight = s.x + s.width;
  const sBottom = s.y + s.height;
  const tBottom = t.y + t.height;
  if (kind === 'approval' || t.kind === 'approval') {
    const p0: Point = [s.x + s.width / 2, sBottom];
    const p3: Point = [t.x + t.width / 2, t.y];
    const midY = (p0[1] + p3[1]) / 2;
    return cubic(p0, [p0[0], midY], [p3[0], midY], p3);
  }
  if (t.x >= sRight + 8) {
    const p0: Point = [sRight, s.y + s.height / 2];
    const p3: Point = [t.x, t.y + t.height / 2];
    const dx = Math.max(24, (p3[0] - p0[0]) / 2);
    return cubic(p0, [p0[0] + dx, p0[1]], [p3[0] - dx, p3[1]], p3);
  }
  if (t.y >= sBottom) {
    // Into a sub-plan below: leave from the lower-left of the source, then turn right.
    const p0: Point = [s.x + 18, sBottom];
    if (t.x > p0[0] + 8) {
      const p3: Point = [t.x, t.y + t.height / 2];
      return cubic(p0, [p0[0], p3[1]], [p0[0], p3[1]], p3);
    }
    const p3: Point = [t.x + t.width / 2, t.y];
    const midY = (p0[1] + p3[1]) / 2;
    return cubic(p0, [p0[0], midY], [p3[0], midY], p3);
  }
  if (tBottom <= s.y) {
    // Back up to the main lane (e.g. a sub-plan result consumed by a later task).
    const p3: Point = [t.x + t.width / 2, tBottom];
    if (p3[0] > sRight) {
      const p0: Point = [sRight, s.y + s.height / 2];
      return cubic(p0, [p3[0], p0[1]], [p3[0], p0[1]], p3);
    }
    const p0: Point = [s.x + s.width / 2, s.y];
    const midY = (p0[1] + p3[1]) / 2;
    return cubic(p0, [p0[0], midY], [p3[0], midY], p3);
  }
  // Behind, in the same band: loop around.
  const p0: Point = [sRight, s.y + s.height / 2];
  const p3: Point = [t.x, t.y + t.height / 2];
  return cubic(p0, [p0[0] + 60, p0[1]], [p3[0] - 60, p3[1]], p3);
}
