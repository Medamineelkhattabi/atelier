// Detailed map: the task's graph (steps, hand-offs, approvals, result) drawn in SVG, with pan (drag), zoom (wheel, buttons,
// + / - keys), fit-to-view and a legend. Every node, status and animation comes from the API graph:
// only edges the API marks `active` move.

import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { Info, Maximize, ZoomIn, ZoomOut } from 'lucide-react';
import type { ExecutionGraph, GraphEdgeKind, GraphNode } from '../../api/types';
import { IconButton } from '../../components/ui';
import { cx } from '../../lib/cx';
import { describeAction, plainTaskText, workStatus } from '../../lib/plain';
import { type Tone } from '../../lib/status';
import { avatarFill } from './agentAvatar';
import { layoutGraph, type GraphLayout, type PositionedLane, type PositionedNode } from './graphLayout';
import { agentName, initials, nodeAriaLabel, nodeStatus, truncateLabel, wrapText } from './graphText';

// ------------------------------------------------------------------ styles (literal Tailwind classes)

interface SvgTone {
  stroke: string;
  bar: string;
  chipFill: string;
  chipText: string;
  soft: string;
}

const SVG_TONE: Record<Tone, SvgTone> = {
  gray: { stroke: 'stroke-zinc-300 dark:stroke-zinc-600', bar: 'fill-zinc-400', chipFill: 'fill-zinc-100 dark:fill-zinc-800', chipText: 'fill-zinc-700 dark:fill-zinc-300', soft: 'fill-zinc-50 dark:fill-zinc-900' },
  blue: { stroke: 'stroke-blue-400 dark:stroke-blue-500', bar: 'fill-blue-500', chipFill: 'fill-blue-50 dark:fill-blue-950', chipText: 'fill-blue-700 dark:fill-blue-300', soft: 'fill-blue-50 dark:fill-blue-950' },
  amber: { stroke: 'stroke-amber-400 dark:stroke-amber-500', bar: 'fill-amber-500', chipFill: 'fill-amber-50 dark:fill-amber-950', chipText: 'fill-amber-800 dark:fill-amber-300', soft: 'fill-amber-50 dark:fill-amber-950' },
  green: { stroke: 'stroke-emerald-400 dark:stroke-emerald-600', bar: 'fill-emerald-500', chipFill: 'fill-emerald-50 dark:fill-emerald-950', chipText: 'fill-emerald-700 dark:fill-emerald-300', soft: 'fill-emerald-50 dark:fill-emerald-950' },
  red: { stroke: 'stroke-red-400 dark:stroke-red-500', bar: 'fill-red-500', chipFill: 'fill-red-50 dark:fill-red-950', chipText: 'fill-red-700 dark:fill-red-300', soft: 'fill-red-50 dark:fill-red-950' },
  slate: { stroke: 'stroke-slate-300 dark:stroke-slate-600', bar: 'fill-slate-400', chipFill: 'fill-slate-100 dark:fill-slate-800', chipText: 'fill-slate-600 dark:fill-slate-300', soft: 'fill-slate-50 dark:fill-slate-900' },
  violet: { stroke: 'stroke-violet-400 dark:stroke-violet-500', bar: 'fill-violet-500', chipFill: 'fill-violet-50 dark:fill-violet-950', chipText: 'fill-violet-700 dark:fill-violet-300', soft: 'fill-violet-50 dark:fill-violet-950' },
  teal: { stroke: 'stroke-teal-400 dark:stroke-teal-500', bar: 'fill-teal-500', chipFill: 'fill-teal-50 dark:fill-teal-950', chipText: 'fill-teal-700 dark:fill-teal-300', soft: 'fill-teal-50 dark:fill-teal-950' },
  orange: { stroke: 'stroke-orange-400 dark:stroke-orange-500', bar: 'fill-orange-500', chipFill: 'fill-orange-50 dark:fill-orange-950', chipText: 'fill-orange-700 dark:fill-orange-300', soft: 'fill-orange-50 dark:fill-orange-950' },
  accent: { stroke: 'stroke-accent-400 dark:stroke-accent-500', bar: 'fill-accent-500', chipFill: 'fill-accent-50 dark:fill-accent-950', chipText: 'fill-accent-700 dark:fill-accent-300', soft: 'fill-accent-50 dark:fill-accent-950' },
};

interface EdgeStyle {
  label: string;
  description: string;
  stroke: string;
  marker: string;
  dash?: string;
  width: number;
}

export const EDGE_STYLE: Record<GraphEdgeKind, EdgeStyle> = {
  delegates: { label: 'Assigns', description: 'gives a step to a team member', stroke: 'stroke-accent-400 dark:stroke-accent-500', marker: 'fill-accent-400 dark:fill-accent-500', width: 1.75 },
  depends_on: { label: 'Waits for', description: 'starts after the earlier step', stroke: 'stroke-zinc-400 dark:stroke-zinc-500', marker: 'fill-zinc-400 dark:fill-zinc-500', width: 1.5 },
  handoff: { label: 'Hand-off', description: 'passes its results on', stroke: 'stroke-teal-500 dark:stroke-teal-400', marker: 'fill-teal-500 dark:fill-teal-400', dash: '6 4', width: 1.75 },
  approval: { label: 'Approval', description: 'an action waits for your decision', stroke: 'stroke-amber-500 dark:stroke-amber-400', marker: 'fill-amber-500 dark:fill-amber-400', dash: '2 4', width: 1.5 },
  consolidates: { label: 'Leads to the result', description: 'goes into the final result', stroke: 'stroke-emerald-500 dark:stroke-emerald-400', marker: 'fill-emerald-500 dark:fill-emerald-400', width: 2 },
};

const EDGE_KINDS = Object.keys(EDGE_STYLE) as GraphEdgeKind[];

const ACTIVE_STROKE = 'stroke-blue-500 dark:stroke-blue-400';

const LEGEND_STATUSES: string[] = ['pending', 'running', 'waiting_approval', 'retrying', 'completed', 'failed', 'skipped'];

const TONE_DOT_CLASS: Record<Tone, string> = {
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

function nodeTone(node: GraphNode): Tone {
  return nodeStatus(node).tone;
}

function nodeStatusText(node: GraphNode): string {
  return nodeStatus(node).label;
}

// ------------------------------------------------------------------ view (pan / zoom)

interface View {
  x: number;
  y: number;
  k: number;
}

const MIN_ZOOM = 0.3;
const MAX_ZOOM = 2;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

function fitView(layout: Pick<GraphLayout, 'width' | 'height'>, width: number, height: number): View {
  if (!width || !height || !layout.width || !layout.height) return { x: 0, y: 0, k: 1 };
  const k = clamp(Math.min(width / layout.width, height / layout.height, 1), MIN_ZOOM, MAX_ZOOM);
  const contentW = layout.width * k;
  const contentH = layout.height * k;
  // Too big even at the minimum zoom: start at the root (top-left) rather than in the middle.
  return { k, x: contentW > width ? 0 : (width - contentW) / 2, y: contentH > height ? 0 : (height - contentH) / 2 };
}

// ------------------------------------------------------------------ component

export interface OrchestrationCanvasProps {
  graph: ExecutionGraph;
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** Agent names from the agents API, used when the graph's own agent table lacks one. */
  agentNames?: Record<string, string>;
  className?: string;
}

export function OrchestrationCanvas({ graph, selectedId, onSelect, agentNames, className }: OrchestrationCanvasProps) {
  const layout = useMemo(() => layoutGraph(graph), [graph]);
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 });
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [legendOpen, setLegendOpen] = useState(false);
  const interacted = useRef(false);
  const drag = useRef<{ pointer: number; startX: number; startY: number; x: number; y: number } | null>(null);
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const helpId = `${uid}-help`;

  const size = () => ({ w: containerRef.current?.clientWidth ?? 0, h: containerRef.current?.clientHeight ?? 0 });

  const fit = useCallback(() => {
    const { w, h } = size();
    setView(fitView(layout, w, h));
  }, [layout]);

  // Latest values for callbacks that outlive a render (resize observer, animation frames).
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;

  /** Centres the node if it is (partly) outside the visible canvas; keeps the zoom. */
  const reveal = useCallback((id: string) => {
    const node = layoutRef.current.byId.get(id);
    const { w, h } = size();
    if (!node || !w || !h) return;
    setView((current) => {
      const left = current.x + node.x * current.k;
      const top = current.y + node.y * current.k;
      const right = left + node.width * current.k;
      const bottom = top + node.height * current.k;
      if (left >= 0 && top >= 0 && right <= w && bottom <= h) return current;
      return { k: current.k, x: w / 2 - (node.x + node.width / 2) * current.k, y: h / 2 - (node.y + node.height / 2) * current.k };
    });
  }, []);

  // Fit when a new execution opens; afterwards only while the owner has not panned or zoomed,
  // and without losing sight of the selected node.
  useEffect(() => {
    interacted.current = false;
  }, [graph.root_run_id]);
  useEffect(() => {
    if (interacted.current) return;
    if (selectedRef.current) reveal(selectedRef.current);
    else fit();
  }, [fit, reveal, layout.width, layout.height]);
  useEffect(() => {
    const element = containerRef.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (selectedRef.current) reveal(selectedRef.current);
      else if (!interacted.current) fit();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [fit, reveal]);

  const zoomAt = useCallback((factor: number, px?: number, py?: number) => {
    interacted.current = true;
    setView((current) => {
      const k = clamp(current.k * factor, MIN_ZOOM, MAX_ZOOM);
      const { w, h } = size();
      const cx_ = px ?? w / 2;
      const cy_ = py ?? h / 2;
      return { k, x: cx_ - ((cx_ - current.x) * k) / current.k, y: cy_ - ((cy_ - current.y) * k) / current.k };
    });
  }, []);

  // Wheel zoom needs a non-passive listener to keep the page from scrolling.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = svg.getBoundingClientRect();
      zoomAt(Math.exp(-event.deltaY * 0.0015), event.clientX - rect.left, event.clientY - rect.top);
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
  }, [zoomAt]);

  // Bring the selected node into view (e.g. "review consolidated result"). Runs on the next frame,
  // because opening the inspector narrows the canvas in the same render.
  useEffect(() => {
    if (!selectedId) return;
    const frame = window.requestAnimationFrame(() => reveal(selectedId));
    return () => window.cancelAnimationFrame(frame);
  }, [selectedId, reveal]);

  const onPointerDown = (event: PointerEvent<SVGSVGElement>) => {
    if (event.button !== 0 || (event.target as Element).closest('[data-node-id]')) return;
    drag.current = { pointer: event.pointerId, startX: event.clientX, startY: event.clientY, x: view.x, y: view.y };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const onPointerMove = (event: PointerEvent<SVGSVGElement>) => {
    const d = drag.current;
    if (!d || d.pointer !== event.pointerId) return;
    interacted.current = true;
    setView((current) => ({ ...current, x: d.x + event.clientX - d.startX, y: d.y + event.clientY - d.startY }));
  };
  const endDrag = (event: PointerEvent<SVGSVGElement>) => {
    if (drag.current?.pointer === event.pointerId) {
      drag.current = null;
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === '+' || event.key === '=') {
      event.preventDefault();
      zoomAt(1.2);
    } else if (event.key === '-' || event.key === '_') {
      event.preventDefault();
      zoomAt(1 / 1.2);
    } else if (event.key === '0') {
      event.preventDefault();
      interacted.current = false;
      fit();
    } else if (event.target === event.currentTarget && event.key.startsWith('Arrow')) {
      event.preventDefault();
      interacted.current = true;
      const step = 48;
      const dx = event.key === 'ArrowLeft' ? step : event.key === 'ArrowRight' ? -step : 0;
      const dy = event.key === 'ArrowUp' ? step : event.key === 'ArrowDown' ? -step : 0;
      setView((current) => ({ ...current, x: current.x + dx, y: current.y + dy }));
    }
  };

  const tasks = graph.nodes.filter((n) => n.kind === 'task').length;
  const active = layout.edges.filter((e) => e.active).length;
  const withPrerequisites = useMemo(
    () => new Set(graph.nodes.filter((n) => n.kind === 'task' && n.depends_on.length > 0).map((n) => n.id)),
    [graph.nodes],
  );

  return (
    <div
      ref={containerRef}
      role="region"
      aria-label="Detailed map"
      aria-describedby={helpId}
      tabIndex={0}
      onKeyDown={onKeyDown}
      className={cx(
        'relative h-full w-full overflow-hidden rounded-lg border border-zinc-200 bg-zinc-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 dark:border-zinc-800 dark:bg-zinc-950',
        className,
      )}
    >
      <p id={helpId} className="sr-only">
        {`${tasks} step${tasks === 1 ? '' : 's'}, ${active} connection${active === 1 ? '' : 's'} in progress. `}
        Drag to move the map; scroll, the zoom buttons or the plus and minus keys to zoom; 0 fits the map. Tab moves between boxes, Enter or
        Space opens the details, Escape closes them.
      </p>
      <svg
        ref={svgRef}
        className="h-full w-full cursor-grab touch-none select-none active:cursor-grabbing"
        role="group"
        aria-label={`Detailed map of “${truncateLabel(plainTaskText(graph.title), 120)}”`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <defs>
          <pattern id={`${uid}-dots`} width="20" height="20" patternUnits="userSpaceOnUse" patternTransform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
            <circle cx="1" cy="1" r="1" className="fill-zinc-300 dark:fill-zinc-800" />
          </pattern>
          {EDGE_KINDS.map((kind) => (
            <marker key={kind} id={`${uid}-arrow-${kind}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0 0 L10 5 L0 10 z" className={EDGE_STYLE[kind].marker} />
            </marker>
          ))}
          <marker id={`${uid}-arrow-active`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0 0 L10 5 L0 10 z" className="fill-blue-500 dark:fill-blue-400" />
          </marker>
        </defs>
        <rect width="100%" height="100%" fill={`url(#${uid}-dots)`} aria-hidden />
        <g transform={`translate(${round(view.x)} ${round(view.y)}) scale(${round3(view.k)})`}>
          {layout.lanes.map((lane) => (
            <LaneBox key={lane.id} lane={lane} layout={layout} graph={graph} agentNames={agentNames} />
          ))}
          <g aria-hidden>
            {layout.edges.map((edge) => {
              const style = EDGE_STYLE[edge.kind] ?? EDGE_STYLE.depends_on;
              // The planner assigns every task; for a task that also waits for others, that line is drawn faint
              // so the dependency lines stay readable (full strength when active or when an end is selected).
              const faint =
                !edge.active && edge.kind === 'delegates' && withPrerequisites.has(edge.target) && edge.source !== selectedId && edge.target !== selectedId;
              return (
                <path
                  key={edge.id}
                  d={edge.path}
                  data-edge-id={edge.id}
                  data-kind={edge.kind}
                  data-active={edge.active ? 'true' : 'false'}
                  data-faint={faint ? 'true' : undefined}
                  opacity={faint ? 0.3 : undefined}
                  fill="none"
                  strokeWidth={edge.active ? style.width + 0.75 : style.width}
                  strokeDasharray={style.dash}
                  strokeLinecap="round"
                  className={cx(edge.active ? cx(ACTIVE_STROKE, 'edge-active') : style.stroke)}
                  markerEnd={`url(#${uid}-arrow-${edge.active ? 'active' : edge.kind})`}
                >
                  <title>{`${style.label}${edge.label ? `: ${edge.label}` : ''}${edge.active ? ' (in progress)' : ''}`}</title>
                </path>
              );
            })}
            {layout.edges
              // Short prose summaries only: a structured (JSON) hand-off stays in the tooltip and the inspector.
              .filter((edge) => edge.label && edge.kind === 'handoff' && !/^\s*[[{]/.test(edge.label))
              .map((edge) => (
                <text key={`${edge.id}-label`} x={edge.midX} y={edge.midY - 6} textAnchor="middle" fontSize={10} className="fill-teal-700 dark:fill-teal-300">
                  {truncateLabel(edge.label!, 24)}
                </text>
              ))}
          </g>
          {layout.nodes.map((p) => (
            <CanvasNode
              key={p.id}
              p={p}
              graph={graph}
              agentNames={agentNames}
              selected={p.id === selectedId}
              focused={p.id === focusedId}
              onSelect={onSelect}
              onFocus={setFocusedId}
            />
          ))}
        </g>
      </svg>

      <div className="absolute right-2 top-2 flex items-center gap-0.5 rounded-md border border-zinc-200 bg-white/95 p-0.5 shadow-sm dark:border-zinc-700 dark:bg-zinc-900/95">
        <IconButton label="Zoom out" onClick={() => zoomAt(1 / 1.2)} disabled={view.k <= MIN_ZOOM + 0.001}>
          <ZoomOut className="h-4 w-4" />
        </IconButton>
        <span className="w-10 text-center text-xs tabular-nums text-zinc-600 dark:text-zinc-300" aria-live="polite" aria-label={`Zoom ${Math.round(view.k * 100)} percent`}>
          {Math.round(view.k * 100)}%
        </span>
        <IconButton label="Zoom in" onClick={() => zoomAt(1.2)} disabled={view.k >= MAX_ZOOM - 0.001}>
          <ZoomIn className="h-4 w-4" />
        </IconButton>
        <IconButton
          label="Fit to view"
          onClick={() => {
            interacted.current = false;
            fit();
          }}
        >
          <Maximize className="h-4 w-4" />
        </IconButton>
        <IconButton label={legendOpen ? 'Hide legend' : 'Show legend'} aria-expanded={legendOpen} onClick={() => setLegendOpen((v) => !v)}>
          <Info className="h-4 w-4" />
        </IconButton>
      </div>
      {legendOpen && <Legend />}
    </div>
  );
}

const round = (value: number) => Math.round(value * 10) / 10;
const round3 = (value: number) => Math.round(value * 1000) / 1000;

// ------------------------------------------------------------------ legend

export function Legend() {
  return (
    <div
      className="absolute bottom-2 left-2 max-h-[calc(100%-4rem)] w-64 max-w-[calc(100%-1rem)] overflow-y-auto rounded-md border border-zinc-200 bg-white/95 p-3 text-xs shadow-sm dark:border-zinc-700 dark:bg-zinc-900/95"
      aria-label="Legend"
      role="note"
    >
      <p className="mb-1.5 font-semibold text-zinc-800 dark:text-zinc-100">Connections</p>
      <ul className="space-y-1">
        {EDGE_KINDS.map((kind) => {
          const style = EDGE_STYLE[kind];
          return (
            <li key={kind} className="flex items-center gap-2 text-zinc-600 dark:text-zinc-300">
              <svg width="28" height="8" aria-hidden className="shrink-0">
                <line x1="1" y1="4" x2="27" y2="4" strokeWidth={style.width} strokeDasharray={style.dash} className={style.stroke} />
              </svg>
              <span>
                <span className="font-medium text-zinc-800 dark:text-zinc-100">{style.label}</span>: {style.description}
              </span>
            </li>
          );
        })}
        <li className="flex items-center gap-2 text-zinc-600 dark:text-zinc-300">
          <svg width="28" height="8" aria-hidden className="shrink-0">
            <line x1="1" y1="4" x2="27" y2="4" strokeWidth={2.5} strokeDasharray="8 6" className={ACTIVE_STROKE} />
          </svg>
          <span>
            <span className="font-medium text-zinc-800 dark:text-zinc-100">Moving dashes</span>: work in progress right now
          </span>
        </li>
      </ul>
      <p className="mb-1.5 mt-3 font-semibold text-zinc-800 dark:text-zinc-100">Step status</p>
      <ul className="grid grid-cols-2 gap-x-2 gap-y-1">
        {LEGEND_STATUSES.map((status) => (
          <li key={status} className="flex items-center gap-1.5 text-zinc-600 dark:text-zinc-300">
            <span className={cx('h-2 w-2 shrink-0 rounded-full', TONE_DOT_CLASS[workStatus(status).tone])} aria-hidden />
            {workStatus(status).label}
          </li>
        ))}
      </ul>
      <p className="mt-3 text-zinc-600 dark:text-zinc-300">
        <span aria-hidden className="mr-1 inline-block h-2.5 w-2.5 rotate-45 border border-amber-500 bg-amber-50 align-middle dark:bg-amber-950" />
        Diamond: an approval. A dashed band groups the steps a team member split its own step into.
      </p>
    </div>
  );
}

// ------------------------------------------------------------------ lanes

function LaneBox({ lane, layout, graph, agentNames }: { lane: PositionedLane; layout: GraphLayout; graph: ExecutionGraph; agentNames?: Record<string, string> }) {
  const parent = layout.byId.get(lane.parentId)?.node;
  const planner = parent && parent.kind === 'task' ? agentName(parent.agent_id, graph.agents, agentNames) : 'a team member';
  const count = lane.taskIds.length;
  return (
    <g data-lane-id={lane.id} aria-hidden>
      <rect
        x={lane.x}
        y={lane.y}
        width={lane.width}
        height={lane.height}
        rx={12}
        strokeDasharray="5 4"
        strokeWidth={1.25}
        className="fill-white/70 stroke-zinc-300 dark:fill-zinc-900/60 dark:stroke-zinc-700"
      />
      <text x={lane.x + 12} y={lane.y + 18} fontSize={11} fontWeight={600} className="fill-zinc-500 dark:fill-zinc-400">
        {truncateLabel(`Split by ${planner} · ${count} step${count === 1 ? '' : 's'}`, Math.max(16, Math.floor(lane.width / 6.5)))}
      </text>
    </g>
  );
}

// ------------------------------------------------------------------ nodes

function Chip({ x, y, text, tone }: { x: number; y: number; text: string; tone: Tone }) {
  const width = Math.round(text.length * 6 + 14);
  const t = SVG_TONE[tone];
  return (
    <g transform={`translate(${x} ${y})`}>
      <rect width={width} height={17} rx={8.5} className={t.chipFill} />
      <circle cx={8} cy={8.5} r={2.5} className={t.bar} />
      <text x={14} y={12.5} fontSize={10.5} fontWeight={500} className={t.chipText}>
        {text}
      </text>
    </g>
  );
}

const chipWidth = (text: string) => Math.round(text.length * 6 + 14);

interface CanvasNodeProps {
  p: PositionedNode;
  graph: ExecutionGraph;
  agentNames?: Record<string, string>;
  selected: boolean;
  focused: boolean;
  onSelect: (id: string) => void;
  onFocus: (id: string | null) => void;
}

function CanvasNode({ p, graph, agentNames, selected, focused, onSelect, onFocus }: CanvasNodeProps) {
  const node = p.node;
  const tone = nodeTone(node);
  const label = nodeAriaLabel(node, graph, agentNames);
  return (
    <g
      data-node-id={p.id}
      data-kind={node.kind}
      data-status={node.status}
      role="button"
      tabIndex={0}
      aria-label={label}
      aria-pressed={selected}
      transform={`translate(${p.x} ${p.y})`}
      className="cursor-pointer focus:outline-none"
      onClick={() => onSelect(p.id)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSelect(p.id);
        }
      }}
      onFocus={() => onFocus(p.id)}
      onBlur={() => onFocus(null)}
    >
      <title>{label}</title>
      {node.kind === 'approval' ? (
        <ApprovalShape width={p.width} tone={tone} status={node.status} tool={describeAction(node.tool, node.args).title} selected={selected} focused={focused} />
      ) : (
        <>
          {(selected || focused) && (
            <rect
              x={-4}
              y={-4}
              width={p.width + 8}
              height={p.height + 8}
              rx={13}
              fill="none"
              strokeWidth={2}
              strokeDasharray={focused && !selected ? '4 3' : undefined}
              className="stroke-accent-500 dark:stroke-accent-400"
            />
          )}
          <rect
            width={p.width}
            height={p.height}
            rx={10}
            strokeWidth={selected ? 2 : 1.5}
            className={cx('fill-white dark:fill-zinc-900', selected ? 'stroke-accent-600 dark:stroke-accent-400' : SVG_TONE[tone].stroke)}
          />
          {node.kind === 'task' && <TaskBody p={p} node={node} graph={graph} agentNames={agentNames} tone={tone} />}
          {node.kind === 'root' && <RootBody p={p} node={node} graph={graph} agentNames={agentNames} tone={tone} />}
          {node.kind === 'result' && <ResultBody p={p} node={node} tone={tone} />}
        </>
      )}
    </g>
  );
}

function TaskBody({ p, node, graph, agentNames, tone }: { p: PositionedNode; node: Extract<GraphNode, { kind: 'task' }>; graph: ExecutionGraph; agentNames?: Record<string, string>; tone: Tone }) {
  const name = agentName(node.agent_id, graph.agents, agentNames);
  const lines = wrapText(node.title, 29, 2);
  const status = nodeStatusText(node);
  const meta = node.attempts > 1 ? `tried ${node.attempts}×` : '';
  return (
    <>
      <rect x={1.5} y={10} width={4} height={p.height - 20} rx={2} className={SVG_TONE[tone].bar} />
      <circle cx={26} cy={24} r={13} className={avatarFill(node.agent_id)} />
      <text x={26} y={28} textAnchor="middle" fontSize={10.5} fontWeight={700} className="fill-white">
        {initials(name)}
      </text>
      <text x={46} y={21} fontSize={12} fontWeight={600} className="fill-zinc-700 dark:fill-zinc-200">
        {truncateLabel(name, 24)}
      </text>
      <Chip x={46} y={27} text={status} tone={tone} />
      {meta && (
        <text x={p.width - 10} y={40} textAnchor="end" fontSize={10} className="fill-zinc-500 dark:fill-zinc-400">
          {meta}
        </text>
      )}
      {lines.map((line, index) => (
        <text key={index} x={14} y={62 + index * 16} fontSize={12.5} fontWeight={500} className="fill-zinc-900 dark:fill-zinc-50">
          {line}
        </text>
      ))}
    </>
  );
}

function RootBody({ p, node, graph, agentNames, tone }: { p: PositionedNode; node: Extract<GraphNode, { kind: 'root' }>; graph: ExecutionGraph; agentNames?: Record<string, string>; tone: Tone }) {
  const status = nodeStatusText(node);
  const lines = wrapText(plainTaskText(graph.title), 29, 2);
  const who = node.agent_id ? agentName(node.agent_id, graph.agents, agentNames) : node.label || node.team_id ? `Team ${node.label || node.team_id}` : '';
  return (
    <>
      <rect x={10} y={1.5} width={p.width - 20} height={4} rx={2} className="fill-accent-500" />
      <text x={14} y={24} fontSize={10} fontWeight={700} letterSpacing={0.8} className="fill-accent-700 dark:fill-accent-300">
        YOUR REQUEST
      </text>
      <Chip x={p.width - chipWidth(status) - 10} y={12} text={status} tone={tone} />
      {lines.map((line, index) => (
        <text key={index} x={14} y={48 + index * 16} fontSize={13} fontWeight={600} className="fill-zinc-900 dark:fill-zinc-50">
          {line}
        </text>
      ))}
      {who && (
        <text x={14} y={p.height - 12} fontSize={11} className="fill-zinc-500 dark:fill-zinc-400">
          {truncateLabel(who, graph.paused ? 20 : 32)}
        </text>
      )}
      {graph.paused && <Chip x={p.width - chipWidth('Paused') - 10} y={p.height - 26} text="Paused" tone="amber" />}
    </>
  );
}

function ResultBody({ p, node, tone }: { p: PositionedNode; node: Extract<GraphNode, { kind: 'result' }>; tone: Tone }) {
  const status = nodeStatusText(node);
  const glyph = node.status === 'completed' ? '✓' : node.status === 'failed' ? '✕' : node.status === 'cancelled' ? '–' : '…';
  return (
    <>
      <circle cx={24} cy={26} r={13} strokeWidth={1.5} className={cx(SVG_TONE[tone].soft, SVG_TONE[tone].stroke)} />
      <text x={24} y={30.5} textAnchor="middle" fontSize={13} fontWeight={700} className={SVG_TONE[tone].chipText}>
        {glyph}
      </text>
      <text x={44} y={22} fontSize={12} fontWeight={600} className="fill-zinc-800 dark:fill-zinc-100">
        Final result
      </text>
      <Chip x={44} y={28} text={status} tone={tone} />
      {node.output_preview && !/^\s*[[{]/.test(node.output_preview) && (
        <text x={12} y={p.height - 12} fontSize={10.5} className="fill-zinc-500 dark:fill-zinc-400">
          {truncateLabel(node.output_preview.replace(/\s+/g, ' '), 28)}
        </text>
      )}
    </>
  );
}

function ApprovalShape({ width, tone, status, tool, selected, focused }: { width: number; tone: Tone; status: string; tool: string; selected: boolean; focused: boolean }) {
  const half = width / 2;
  const glyph = status === 'pending' ? '?' : status === 'approved' ? '✓' : status === 'rejected' ? '✕' : '–';
  const t = SVG_TONE[tone];
  return (
    <>
      {(selected || focused) && (
        <polygon
          points={`${half},-6 ${width + 6},${half} ${half},${width + 6} -6,${half}`}
          fill="none"
          strokeWidth={2}
          strokeDasharray={focused && !selected ? '4 3' : undefined}
          className="stroke-accent-500 dark:stroke-accent-400"
        />
      )}
      <polygon points={`${half},0 ${width},${half} ${half},${width} 0,${half}`} strokeWidth={1.5} className={cx(t.soft, t.stroke)} />
      <text x={half} y={half + 4.5} textAnchor="middle" fontSize={13} fontWeight={700} className={t.chipText}>
        {glyph}
      </text>
      <text x={half} y={width + 14} textAnchor="middle" fontSize={10} className="fill-zinc-600 dark:fill-zinc-300">
        {truncateLabel(tool, 14)}
      </text>
    </>
  );
}

