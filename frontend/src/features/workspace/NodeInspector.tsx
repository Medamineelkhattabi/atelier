// Details of the selected box on the detailed map: who works on it and why, what it received,
// what it produced, actions used, usage, errors, approvals (inline decision) and the technical runs behind it.
// Everything shown comes from the graph, the run detail or the run's events.

import { useMemo, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, ExternalLink, X } from 'lucide-react';
import { listAgents, listTools } from '../../api/endpoints';
import { qk } from '../../api/keys';
import type {
  ApprovalGraphNode,
  ExecutionGraph,
  GraphNode,
  JsonValue,
  NodeUsage,
  ResultGraphNode,
  RootGraphNode,
  RunDetailResponse,
  RunEvent,
  TaskGraphNode,
} from '../../api/types';
import { Alert, Badge, Disclosure, IconButton, JsonBlock, Mono, RiskBadge } from '../../components/ui';
import { cx } from '../../lib/cx';
import { formatCost, formatDateTime, formatDuration, formatTokens, parseTs } from '../../lib/format';
import { useNow } from '../../lib/hooks';
import { TONE_BADGE, TONE_DOT, isTerminal, riskDescription } from '../../lib/status';
import { describeAction, memberName, readReport, workStatus } from '../../lib/plain';
import { ApprovalCard } from '../approvals/ApprovalCard';
import { runTitle } from '../runs/RunPanels';
import { FinalResult, TaskEnded } from './FinalResult';
import { OutcomeBadge } from './ResultParts';
import { cleanSummary, mergeNames, plainError, planTitles } from './steps';
import { AgentAvatar } from './agentAvatar';
import { agentName } from './graphText';
import { Markdown, shortenText } from '../../lib/markdown';

export interface NodeInspectorProps {
  graph: ExecutionGraph;
  nodeId: string;
  run?: RunDetailResponse;
  events?: RunEvent[];
  onSelect: (id: string) => void;
  onClose: () => void;
  onApprovalDecided?: () => void;
  headingId?: string;
}

export function NodeInspector(props: NodeInspectorProps) {
  const { graph, nodeId, onClose, headingId } = props;
  const node = graph.nodes.find((n) => n.id === nodeId);
  const title = !node
    ? 'Details'
    : node.kind === 'root'
      ? 'Your request'
      : node.kind === 'task'
        ? 'Step'
        : node.kind === 'approval'
          ? 'Approval'
          : 'Final result';
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-zinc-200 px-4 py-2.5 dark:border-zinc-800">
        <h2 id={headingId} className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
          {title}
        </h2>
        <IconButton label="Close details" onClick={onClose}>
          <X className="h-4 w-4" />
        </IconButton>
      </div>
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-4">
        {!node ? (
          <p className="text-sm text-zinc-500">This box is no longer on the map.</p>
        ) : node.kind === 'task' ? (
          <TaskInspector {...props} node={node} />
        ) : node.kind === 'root' ? (
          <RootInspector {...props} node={node} />
        ) : node.kind === 'approval' ? (
          <ApprovalInspector {...props} node={node} />
        ) : (
          <ResultInspector {...props} node={node} />
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ building blocks

function Section({ title, children, className }: { title: string; children: ReactNode; className?: string }) {
  return (
    <section className={className}>
      <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">{title}</h3>
      {children}
    </section>
  );
}

function TaskStatusBadge({ status }: { status: string }) {
  const plain = workStatus(status);
  return (
    <span title={plain.hint} className={cx('inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset', TONE_BADGE[plain.tone])}>
      <span className={cx('h-1.5 w-1.5 rounded-full', TONE_DOT[plain.tone])} aria-hidden />
      {plain.label}
    </span>
  );
}

function Prose({ children }: { children: string }) {
  if (children.length > 700) {
    return (
      <>
        <Markdown text={shortenText(children, 600)} />
        <Disclosure summary={`Show all (${children.length} characters)`} className="mt-1">
          <Markdown text={children} />
        </Disclosure>
      </>
    );
  }
  return <Markdown text={children} />;
}

/**
 * An output preview: structured outputs share an envelope (status, summary, issues), shown in words,
 * with the full JSON on demand. Text (or a truncated preview that does not parse) is shown as is.
 */
export function OutputPreview({ text }: { text: string }) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return <Prose>{text}</Prose>;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return <JsonBlock value={parsed as JsonValue} maxHeight="max-h-72" />;
  const report = readReport(parsed);
  return (
    <div className="space-y-1.5">
      <OutcomeBadge outcome={report.outcome} />
      {report.summary && <Prose>{report.summary}</Prose>}
      {report.answer && <Prose>{report.answer}</Prose>}
      {report.issues.length > 0 && (
        <ul className="list-inside list-disc text-sm text-amber-800 dark:text-amber-300" aria-label="Issues reported">
          {report.issues.map((issue) => (
            <li key={issue}>{issue}</li>
          ))}
        </ul>
      )}
      <Disclosure summary="Technical details (raw data)">
        <JsonBlock value={parsed as JsonValue} maxHeight="max-h-72" />
      </Disclosure>
    </div>
  );
}

function useAgentDirectory() {
  const query = useQuery({ queryKey: qk.agents, queryFn: listAgents, staleTime: 60_000 });
  return useMemo(() => new Map((query.data?.items ?? []).map((a) => [a.id, a])), [query.data]);
}

function AgentIdentity({ agentId, graph }: { agentId: string; graph: ExecutionGraph }) {
  const directory = useAgentDirectory();
  const agent = directory.get(agentId);
  const name = graph.agents[agentId]?.name || agent?.name || memberName(agentId);
  const responsibility = graph.agents[agentId]?.responsibility || agent?.responsibility || agent?.description;
  return (
    <div className="flex items-start gap-3">
      <AgentAvatar agentId={agentId} name={name} />
      <div className="min-w-0">
        <p className="flex flex-wrap items-center gap-x-2 text-sm font-semibold text-zinc-900 dark:text-zinc-100">
          <Link to={`/team/${encodeURIComponent(agentId)}`} className="hover:underline">
            {name}
          </Link>
        </p>
        {responsibility && <p className="mt-0.5 text-sm text-zinc-700 dark:text-zinc-300">{responsibility}</p>}
      </div>
    </div>
  );
}

function elapsed(startedAt: string | null, finishedAt: string | null, now: number): number | null {
  const start = parseTs(startedAt);
  if (!start) return null;
  const end = parseTs(finishedAt)?.getTime() ?? now;
  return Math.max(0, (end - start.getTime()) / 1000);
}

function UsageGrid({ usage, startedAt, finishedAt, running, label }: { usage: NodeUsage; startedAt: string | null; finishedAt: string | null; running: boolean; label?: string }) {
  const now = useNow(1000, running);
  const duration = usage.duration_s ?? elapsed(startedAt, finishedAt, now);
  const items = [
    { label: 'Duration', value: formatDuration(duration), hint: running && usage.duration_s === null ? 'so far' : undefined },
    { label: 'Tokens in / out', value: `${formatTokens(usage.input_tokens)} / ${formatTokens(usage.output_tokens)}` },
    { label: 'Usage estimate', value: formatCost(usage.cost_usd), hint: 'API-equivalent estimate, not billed' },
    { label: 'Model turns · actions', value: `${usage.steps} · ${usage.tool_calls}` },
  ];
  return (
    <>
      {label && <p className="mb-1 text-xs text-zinc-500 dark:text-zinc-400">{label}</p>}
      <dl className="grid grid-cols-2 gap-2">
        {items.map((item) => (
          <div key={item.label} className="rounded-md bg-zinc-50 px-2.5 py-2 dark:bg-zinc-950/60">
            <dt className="text-[0.7rem] font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">{item.label}</dt>
            <dd className="text-sm font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">{item.value}</dd>
            {item.hint && <dd className="text-[0.7rem] text-zinc-500 dark:text-zinc-400">{item.hint}</dd>}
          </div>
        ))}
      </dl>
    </>
  );
}

function NodeLink({ node, graph, onSelect }: { node: GraphNode; graph: ExecutionGraph; onSelect: (id: string) => void }) {
  const label =
    node.kind === 'task' ? node.title : node.kind === 'root' ? 'Your request' : node.kind === 'result' ? 'Final result' : `Approval: ${describeAction(node.tool, node.args).title}`;
  const agent = node.kind === 'task' ? agentName(node.agent_id, graph.agents) : null;
  return (
    <button
      type="button"
      onClick={() => onSelect(node.id)}
      className="group inline-flex max-w-full items-center gap-1 text-left text-sm font-medium text-accent-700 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 dark:text-accent-300"
    >
      <span className="truncate">{label}</span>
      {agent && <span className="shrink-0 font-normal text-zinc-500 dark:text-zinc-400">· {agent}</span>}
    </button>
  );
}

function RunLinks({ runIds, current }: { runIds: string[]; current: string | null }) {
  if (runIds.length === 0) return <p className="text-sm text-zinc-500 dark:text-zinc-400">Not started yet.</p>;
  return (
    <ol className="space-y-1">
      {runIds.map((id, index) => (
        <li key={id} className="flex items-center gap-2 text-sm">
          <span className="w-16 shrink-0 text-xs text-zinc-500 dark:text-zinc-400">Attempt {index + 1}</span>
          <Link to={`/runs/${id}`} className="inline-flex items-center gap-1 font-medium text-accent-700 hover:underline dark:text-accent-300">
            <Mono className="text-xs">{id.slice(0, 8)}</Mono>
            <ExternalLink className="h-3 w-3" aria-hidden />
          </Link>
          {id === current && <Badge tone="blue">current</Badge>}
        </li>
      ))}
    </ol>
  );
}

function approvalsOf(graph: ExecutionGraph, nodeId: string): ApprovalGraphNode[] {
  const order = { pending: 0 } as Record<string, number>;
  return graph.nodes
    .filter((n): n is ApprovalGraphNode => n.kind === 'approval' && n.attached_to === nodeId)
    .sort((a, b) => (order[a.status] ?? 1) - (order[b.status] ?? 1));
}

function GateCard({ gate, graph, onDecided }: { gate: ApprovalGraphNode; graph: ExecutionGraph; onDecided?: () => void }) {
  return (
    <ApprovalCard
      approval={{
        id: gate.approval_id,
        tool: gate.tool,
        args: gate.args as unknown as JsonValue,
        risk: gate.risk,
        reason: gate.reason,
        status: gate.status,
        run_id: gate.run_id,
        root_run_id: graph.root_run_id,
      }}
      onDecided={() => onDecided?.()}
    />
  );
}

// ------------------------------------------------------------------ task

function TaskInspector({ graph, node, onSelect, onApprovalDecided }: NodeInspectorProps & { node: TaskGraphNode }) {
  const tools = useQuery({ queryKey: qk.tools, queryFn: listTools, staleTime: 5 * 60_000 });
  const risks = useMemo(() => new Map((tools.data?.items ?? []).map((t) => [t.name, t.risk])), [tools.data]);
  const byId = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n])), [graph.nodes]);
  const handoffs = graph.edges.filter((e) => e.kind === 'handoff' && e.target === node.id);
  const prerequisites = node.depends_on.map((id) => byId.get(id)).filter((n): n is GraphNode => !!n);
  const gates = approvalsOf(graph, node.id);
  const toolsUsed = Object.entries(node.tools_used ?? {}).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const outputRun = node.current_run_id ?? node.run_ids[node.run_ids.length - 1] ?? null;
  const running = node.status === 'running' || node.status === 'waiting_approval' || node.status === 'retrying';
  const subTasks = graph.nodes.filter((n): n is TaskGraphNode => n.kind === 'task' && n.parent_id === node.id);

  return (
    <>
      <Section title="Team member">
        <AgentIdentity agentId={node.agent_id} graph={graph} />
      </Section>

      <Section title="What they are doing">
        <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{node.title}</p>
        <div className="mt-1.5 flex flex-wrap items-center gap-2">
          <TaskStatusBadge status={node.status} />
          {node.attempts > 1 && <Badge tone="orange">tried {node.attempts} times</Badge>}
          {node.pending_approvals > 0 && <Badge tone="amber">{node.pending_approvals === 1 ? 'waiting for your approval' : `${node.pending_approvals} approvals waiting`}</Badge>}
        </div>
        {workStatus(node.status).hint && <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{workStatus(node.status).hint}</p>}
      </Section>

      <Section title="Why this team member">
        {node.reason ? <Prose>{node.reason}</Prose> : <p className="text-sm text-zinc-500 dark:text-zinc-400">No reason was recorded.</p>}
      </Section>

      {node.error && (
        <Alert tone="red" title={node.status === 'retrying' ? 'The previous attempt did not work' : 'What went wrong'}>
          <p>{plainError(node.error, { titles: planTitles(graph, node.plan_id) })}</p>
          <p className="mt-1 whitespace-pre-wrap font-mono text-xs">{node.error}</p>
        </Alert>
      )}

      {gates.length > 0 && (
        <Section title="Approvals">
          <ul className="space-y-2">
            {gates.map((gate) => (
              <li key={gate.id}>
                <GateCard gate={gate} graph={graph} onDecided={onApprovalDecided} />
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section title="What it was asked">
        {node.input_summary ? <Prose>{node.input_summary}</Prose> : <p className="text-sm text-zinc-500 dark:text-zinc-400">Not recorded yet.</p>}
        {prerequisites.length > 0 && (
          <div className="mt-2">
            <p className="text-xs font-medium text-zinc-600 dark:text-zinc-400">Waits for</p>
            <ul className="mt-0.5 space-y-0.5">
              {prerequisites.map((p) => (
                <li key={p.id}>
                  <NodeLink node={p} graph={graph} onSelect={onSelect} />
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="mt-2">
          <p className="text-xs font-medium text-zinc-600 dark:text-zinc-400">Received from</p>
          {handoffs.length === 0 ? (
            <p className="text-sm text-zinc-500 dark:text-zinc-400">None yet.</p>
          ) : (
            <ul className="mt-0.5 space-y-1.5">
              {handoffs.map((edge) => {
                const source = byId.get(edge.source);
                return (
                  <li key={edge.id} className="text-sm">
                    {source ? <NodeLink node={source} graph={graph} onSelect={onSelect} /> : <Mono>{edge.source}</Mono>}
                    {cleanSummary(edge.label) && <p className="mt-0.5 text-xs text-zinc-600 dark:text-zinc-400">{cleanSummary(edge.label)}</p>}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </Section>

      <Section title="Result">
        {node.output_preview ? <OutputPreview text={node.output_preview} /> : <p className="text-sm text-zinc-500 dark:text-zinc-400">{running ? 'Not finished yet.' : 'No result.'}</p>}
        {outputRun && (
          <Link to={`/runs/${outputRun}`} className="mt-1.5 inline-flex items-center gap-1 text-xs font-medium text-accent-700 hover:underline dark:text-accent-300">
            Technical details of this step <ArrowRight className="h-3 w-3" aria-hidden />
          </Link>
        )}
      </Section>

      {subTasks.length > 0 && (
        <Section title={`Split into ${subTasks.length} step${subTasks.length === 1 ? '' : 's'}`}>
          <ul className="space-y-1">
            {subTasks.map((task) => (
              <li key={task.id} className="flex items-center justify-between gap-2">
                <NodeLink node={task} graph={graph} onSelect={onSelect} />
                <TaskStatusBadge status={task.status} />
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section title="Actions used">
        {toolsUsed.length === 0 ? (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">No action yet.</p>
        ) : (
          <ul className="space-y-1.5" aria-label="Tools used">
            {toolsUsed.map(([tool, count]) => {
              const risk = risks.get(tool);
              return (
                <li key={tool} className="flex flex-wrap items-center gap-2 text-sm">
                  <Mono className="font-semibold text-zinc-900 dark:text-zinc-100">{tool}</Mono>
                  <span className="tabular-nums text-zinc-600 dark:text-zinc-400">×{count}</span>
                  {risk && <RiskBadge risk={risk} />}
                  {risk && <span className="basis-full text-xs text-zinc-500 dark:text-zinc-400">{riskDescription(risk)}</span>}
                </li>
              );
            })}
          </ul>
        )}
      </Section>

      <Section title="Usage">
        <UsageGrid usage={node.usage} startedAt={node.started_at} finishedAt={node.finished_at} running={running} />
        <p className="mt-1.5 text-xs text-zinc-500 dark:text-zinc-400">
          {node.started_at ? `Started ${formatDateTime(node.started_at)}` : 'Not started'}
          {node.finished_at && ` · finished ${formatDateTime(node.finished_at)}`}
        </p>
      </Section>

      <Section title={`Technical details (${node.attempts} attempt${node.attempts === 1 ? '' : 's'})`}>
        <RunLinks runIds={node.run_ids} current={node.current_run_id} />
      </Section>
    </>
  );
}

// ------------------------------------------------------------------ root

function latestPlanFor(events: RunEvent[] | undefined, runId: string): Record<string, unknown> | null {
  if (!events) return null;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!;
    if (event.type === 'plan.created' && (event.data.created_by_run_id === runId || event.run_id === runId)) return event.data;
  }
  return null;
}

function RootInspector({ graph, node, run, events, onSelect, onApprovalDecided }: NodeInspectorProps & { node: RootGraphNode }) {
  const tasks = graph.nodes.filter((n): n is TaskGraphNode => n.kind === 'task');
  const mainTasks = tasks.filter((t) => t.parent_id === node.id);
  const nested = new Set(tasks.filter((t) => t.parent_id !== node.id).map((t) => `${t.parent_id}::${t.plan_id}`)).size;
  const counts = new Map<string, number>();
  for (const task of tasks) counts.set(task.status, (counts.get(task.status) ?? 0) + 1);
  const plan = latestPlanFor(events, node.run_id);
  const maxParallel = typeof plan?.max_parallel === 'number' ? plan.max_parallel : null;
  const gates = approvalsOf(graph, node.id);
  const objective = run?.run.task || graph.title;
  const running = !isTerminal(node.status);

  return (
    <>
      <Section title="Your request">
        <Prose>{objective}</Prose>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <TaskStatusBadge status={node.status} />
          {graph.paused && !isTerminal(node.status) && <Badge tone="amber">Paused: no new step starts</Badge>}
        </div>
      </Section>

      <Section title="Given to">
        {node.agent_id ? (
          <AgentIdentity agentId={node.agent_id} graph={graph} />
        ) : (
          <p className="text-sm text-zinc-800 dark:text-zinc-200">{run ? runTitle(run.run) : (node.team_id ?? 'Team')}</p>
        )}
        {run?.run.team && <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{TEAM_MODE[run.run.team.mode] ?? run.run.team.mode}</p>}
      </Section>

      {node.error && (
        <Alert tone="red" title="What went wrong">
          <p>{plainError(node.error)}</p>
          <p className="mt-1 whitespace-pre-wrap font-mono text-xs">{node.error}</p>
        </Alert>
      )}

      {gates.length > 0 && (
        <Section title="Approvals">
          <ul className="space-y-2">
            {gates.map((gate) => (
              <li key={gate.id}>
                <GateCard gate={gate} graph={graph} onDecided={onApprovalDecided} />
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section title="Steps">
        {tasks.length === 0 ? (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">{running ? 'No step planned yet.' : 'The work was not split into steps.'}</p>
        ) : (
          <>
            <p className="text-sm text-zinc-700 dark:text-zinc-300">
              {tasks.length} step{tasks.length === 1 ? '' : 's'}
              {nested > 0 && `, including ${nested} group${nested === 1 ? '' : 's'} of steps split by team members`}
              {maxParallel !== null && ` · up to ${maxParallel} at the same time`}
            </p>
            <ul className="mt-1.5 flex flex-wrap gap-1.5">
              {[...counts.entries()].map(([status, count]) => (
                <li key={status}>
                  <TaskStatusBadge status={status} />
                  <span className="ml-1 text-xs tabular-nums text-zinc-600 dark:text-zinc-400">{count}</span>
                </li>
              ))}
            </ul>
            <ol className="mt-2 space-y-1">
              {mainTasks.map((task) => (
                <li key={task.id} className="flex items-center justify-between gap-2">
                  <NodeLink node={task} graph={graph} onSelect={onSelect} />
                  <TaskStatusBadge status={task.status} />
                </li>
              ))}
            </ol>
          </>
        )}
      </Section>

      <Section title="Usage">
        <UsageGrid usage={node.usage} startedAt={node.started_at} finishedAt={node.finished_at} running={running} label="Its own work (without the steps)" />
        {run && run.tree.length > 1 && (
          <p className="mt-1.5 text-xs text-zinc-600 dark:text-zinc-400">
            Whole task: {formatTokens(run.tree_totals.input_tokens)} in / {formatTokens(run.tree_totals.output_tokens)} out ·{' '}
            {formatCost(run.tree_totals.cost_usd)} API-equivalent estimate, not billed
          </p>
        )}
      </Section>

      <Section title="Final result">
        <RootResult graph={graph} run={run} />
      </Section>

      <Link to={`/runs/${node.run_id}`} className="inline-flex items-center gap-1 text-sm font-medium text-accent-700 hover:underline dark:text-accent-300">
        Technical details <ArrowRight className="h-3.5 w-3.5" aria-hidden />
      </Link>
    </>
  );
}

// ------------------------------------------------------------------ result

function ResultInspector({ graph, node, run, onSelect }: NodeInspectorProps & { node: ResultGraphNode }) {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const sources = graph.edges.filter((e) => e.kind === 'consolidates' && e.target === node.id).map((e) => byId.get(e.source)).filter((n): n is GraphNode => !!n);
  return (
    <>
      <Section title="Status">
        <TaskStatusBadge status={node.status} />
        {node.status === 'pending' && <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">Ready once every step is done.</p>}
      </Section>
      {sources.length > 0 && (
        <Section title="Built from">
          <ul className="space-y-0.5">
            {sources.map((source) => (
              <li key={source.id}>
                <NodeLink node={source} graph={graph} onSelect={onSelect} />
              </li>
            ))}
          </ul>
        </Section>
      )}
      <Section title="Final result">
        <RootResult graph={graph} run={run} />
      </Section>
      <Link to={`/runs/${graph.root_run_id}`} className="inline-flex items-center gap-1 text-sm font-medium text-accent-700 hover:underline dark:text-accent-300">
        Technical details <ArrowRight className="h-3.5 w-3.5" aria-hidden />
      </Link>
    </>
  );
}

// ------------------------------------------------------------------ approval

function ApprovalInspector({ graph, node, onSelect, onApprovalDecided }: NodeInspectorProps & { node: ApprovalGraphNode }) {
  const host = graph.nodes.find((n) => n.id === node.attached_to);
  return (
    <>
      {host && (
        <Section title="Asked by">
          <NodeLink node={host} graph={graph} onSelect={onSelect} />
        </Section>
      )}
      <Section title="What it would do">
        <p className="mb-2 text-sm text-zinc-700 dark:text-zinc-300">
          {describeAction(node.tool, node.args).title}: {describeAction(node.tool, node.args).effect}
        </p>
        <GateCard gate={node} graph={graph} onDecided={onApprovalDecided} />
      </Section>
    </>
  );
}

const TEAM_MODE: Record<string, string> = {
  sequential: 'The team works one after the other.',
  parallel: 'The team members work at the same time.',
  orchestrated: 'The Coordinator organises the team.',
};

/** The final result of the whole task (plain), or why there is none yet. */
function RootResult({ graph, run }: { graph: ExecutionGraph; run?: RunDetailResponse }) {
  const names = useMemo(() => mergeNames(graph), [graph]);
  if (!run || !isTerminal(run.run.status)) {
    return <p className="text-sm text-zinc-500 dark:text-zinc-400">The final result appears here when the task is done.</p>;
  }
  return run.run.status === 'completed' ? <FinalResult run={run.run} names={names} /> : <TaskEnded run={run.run} names={names} projectId={graph.project_id} />;
}
