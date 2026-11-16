// Readable execution timeline. Every row is one event returned by the API, labelled with its
// source: Agent (model actions), Tool (observed execution), Runtime (orchestration), Owner (you).

import { createContext, useContext, useMemo, type ComponentType, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  Activity,
  ArrowDownLeft,
  ArrowUpRight,
  Ban,
  Bot,
  Braces,
  CircleCheck,
  CirclePause,
  CirclePlay,
  CircleX,
  Clock,
  Cpu,
  ExternalLink,
  Flag,
  Gauge,
  GitBranch,
  GitMerge,
  Info,
  Lightbulb,
  ListOrdered,
  MessageSquare,
  Play,
  RefreshCw,
  RotateCcw,
  Shield,
  ShieldCheck,
  ShieldQuestion,
  TriangleAlert,
  User,
  Users,
  Wrench,
} from 'lucide-react';
import type { Approval, ApprovalStatus, EventSource_, RunEvent } from '../../api/types';
import { Badge, Disclosure, IconButton, JsonBlock, Mono, PermissionBadge, StatusBadge } from '../../components/ui';
import { cx } from '../../lib/cx';
import { formatCost, formatDateTime, formatMs, formatTime, formatTokens, pretty } from '../../lib/format';
import { sourceStyle } from '../../lib/status';
import { ApprovalCard } from '../approvals/ApprovalCard';
import { buildTimeline, toolCardState, type TimelineGroup, type ToolCardState, type ToolItem } from './timelineModel';

// ------------------------------------------------------------------ context

interface TimelineContextValue {
  approvals: Map<string, Approval>;
  onInspect: (event: RunEvent) => void;
  currentRunId?: string;
}

const TimelineContext = createContext<TimelineContextValue>({ approvals: new Map(), onInspect: () => undefined });

export function TimelineProvider({
  approvals,
  onInspect,
  currentRunId,
  children,
}: {
  approvals: Approval[];
  onInspect: (event: RunEvent) => void;
  currentRunId?: string;
  children: ReactNode;
}) {
  const value = useMemo(
    () => ({ approvals: new Map(approvals.map((a) => [a.id, a])), onInspect, currentRunId }),
    [approvals, onInspect, currentRunId],
  );
  return <TimelineContext.Provider value={value}>{children}</TimelineContext.Provider>;
}

// ------------------------------------------------------------------ small helpers

const s = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);
const n = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

const SOURCE_ICON: Record<EventSource_, ComponentType<{ className?: string }>> = {
  agent: Bot,
  tool: Wrench,
  runtime: Cpu,
  user: User,
};

export function SourceChip({ source }: { source: string }) {
  const style = sourceStyle(source);
  const Icon = SOURCE_ICON[source as EventSource_] ?? Cpu;
  return (
    <Badge tone={style.tone} title={style.description} className="uppercase tracking-wide">
      <Icon className="h-3 w-3" aria-hidden />
      {style.label}
    </Badge>
  );
}

function RunLink({ runId, label }: { runId: string; label?: string }) {
  const { currentRunId } = useContext(TimelineContext);
  if (runId === currentRunId) return null;
  return (
    <Link
      to={`/runs/${runId}`}
      className="inline-flex items-center gap-1 text-xs font-medium text-accent-700 hover:underline dark:text-accent-300"
    >
      <ExternalLink className="h-3 w-3" aria-hidden />
      {label ?? 'Open run'} <Mono className="text-[0.7rem]">{runId.slice(0, 8)}</Mono>
    </Link>
  );
}

function Text({ children, muted = false }: { children: string; muted?: boolean }) {
  return (
    <p
      className={cx(
        'mt-1 whitespace-pre-wrap break-words text-sm leading-relaxed',
        muted ? 'italic text-zinc-600 dark:text-zinc-400' : 'text-zinc-800 dark:text-zinc-200',
      )}
    >
      {children}
    </p>
  );
}

function Meta({ items }: { items: (string | number | false | null | undefined)[] }) {
  const parts = items.filter((item): item is string => typeof item === 'string' && item !== '');
  if (parts.length === 0) return null;
  return <span className="text-xs text-zinc-500 dark:text-zinc-400">{parts.join(' · ')}</span>;
}

function Collapsible({ label, value, open = false }: { label: string; value: unknown; open?: boolean }) {
  if (value === undefined || value === null || value === '') return null;
  return (
    <Disclosure summary={label} defaultOpen={open} className="mt-1.5">
      <JsonBlock value={typeof value === 'string' ? value : pretty(value)} maxHeight="max-h-80" />
    </Disclosure>
  );
}

// ------------------------------------------------------------------ event descriptions

type Emphasis = 'error' | 'success' | 'warning' | undefined;

interface Description {
  icon: ComponentType<{ className?: string }>;
  title: ReactNode;
  meta?: ReactNode;
  body?: ReactNode;
  emphasis?: Emphasis;
}

function usageMeta(data: Record<string, unknown>): string[] {
  const usage = (data.usage ?? {}) as Record<string, unknown>;
  const input = n(usage.input_tokens);
  const output = n(usage.output_tokens);
  const cacheRead = n(usage.cache_read_tokens) ?? n(usage.cache_read_input_tokens);
  const parts: string[] = [];
  if (input !== undefined) parts.push(`${formatTokens(input)} in`);
  if (output !== undefined) parts.push(`${formatTokens(output)} out`);
  if (cacheRead) parts.push(`${formatTokens(cacheRead)} cache read`);
  return parts;
}

export function describeEvent(event: RunEvent): Description {
  const d = event.data ?? {};
  switch (event.type) {
    // ---------------- agent
    case 'agent.message':
      return { icon: MessageSquare, title: 'Message', body: s(d.text) && <Text>{s(d.text)!}</Text> };
    case 'agent.reasoning': {
      const text = s(d.text) ?? '';
      return {
        icon: Lightbulb,
        title: 'Reasoning summary',
        meta: <Meta items={['supplied by the provider']} />,
        body:
          text.length > 600 ? (
            <Disclosure summary={`Show summary (${text.length} characters)`} className="mt-1">
              <Text muted>{text}</Text>
            </Disclosure>
          ) : (
            text && <Text muted>{text}</Text>
          ),
      };
    }
    case 'agent.tool_call':
      return {
        icon: Wrench,
        title: (
          <>
            Requested <Mono>{s(d.tool) ?? 'tool'}</Mono>
          </>
        ),
        body: <Collapsible label="Input" value={d.input} open />,
      };
    case 'agent.final':
      return {
        icon: Flag,
        title: 'Final answer',
        emphasis: 'success',
        body:
          d.output !== undefined && d.output !== null ? (
            <Collapsible label="Structured output" value={d.output} open />
          ) : (
            s(d.output_text) && <Text>{s(d.output_text)!}</Text>
          ),
      };

    // ---------------- tool
    case 'tool.started':
      return { icon: Play, title: (<>Execution started <Mono>{s(d.tool) ?? ''}</Mono></>) };
    case 'tool.completed':
      return {
        icon: CircleCheck,
        title: (<>Execution completed <Mono>{s(d.tool) ?? ''}</Mono></>),
        meta: <Meta items={[n(d.duration_ms) !== undefined && formatMs(n(d.duration_ms))]} />,
        emphasis: 'success',
        body: (
          <>
            <Collapsible label="Output" value={d.output} />
            <Collapsible label="Data" value={d.data} />
          </>
        ),
      };
    case 'tool.failed':
      return {
        icon: CircleX,
        title: (<>Execution failed <Mono>{s(d.tool) ?? ''}</Mono></>),
        meta: <Meta items={[n(d.duration_ms) !== undefined && formatMs(n(d.duration_ms))]} />,
        emphasis: 'error',
        body: (
          <>
            {s(d.error) && <Text>{s(d.error)!}</Text>}
            <Collapsible label="Output" value={d.output !== d.error ? d.output : undefined} />
          </>
        ),
      };

    // ---------------- runtime: lifecycle
    case 'run.queued':
      return {
        icon: Clock,
        title: 'Queued',
        meta: <Meta items={[s(d.kind), s(d.agent_id) ?? s(d.team_id), s(d.provider), s(d.model)]} />,
        body: (
          <>
            {s(d.task) && <Collapsible label="Task" value={s(d.task)} />}
            <Collapsible label="Workspace and limits" value={{ workspace: d.workspace, limits: d.limits }} />
          </>
        ),
      };
    case 'run.started':
    case 'run.resumed':
      return {
        icon: event.type === 'run.resumed' ? RotateCcw : CirclePlay,
        title: event.type === 'run.resumed' ? 'Resumed from checkpoint' : 'Started',
        meta: (
          <Meta
            items={[
              s(d.agent_id) ?? s(d.kind),
              s(d.provider),
              s(d.model),
              s(d.agent_version) && `v${s(d.agent_version)}`,
              n(d.depth) ? `depth ${n(d.depth)}` : null,
            ]}
          />
        ),
        body: s(d.role) && <Text muted>{`Responsibility: ${s(d.role)}`}</Text>,
      };
    case 'run.status':
      return { icon: Activity, title: 'Status', meta: <StatusBadge status={s(d.status)} /> };
    case 'run.completed':
      return {
        icon: CircleCheck,
        title: 'Run completed',
        emphasis: 'success',
        meta: (
          <Meta
            items={[
              n(d.steps) !== undefined && `${n(d.steps)} steps`,
              n(d.tool_calls) !== undefined && `${n(d.tool_calls)} tool calls`,
              n(d.input_tokens) !== undefined && `${formatTokens(n(d.input_tokens))} in / ${formatTokens(n(d.output_tokens) ?? 0)} out`,
              n(d.cost_usd) !== undefined && `${formatCost(n(d.cost_usd))} estimated`,
              n(d.duration_s) !== undefined && formatMs((n(d.duration_s) ?? 0) * 1000),
            ]}
          />
        ),
        body: <Collapsible label="Output preview" value={s(d.output_preview)} />,
      };
    case 'run.failed':
      return {
        icon: CircleX,
        title: 'Run failed',
        emphasis: 'error',
        meta: s(d.code) && <Badge tone="red">{s(d.code)}</Badge>,
        body: s(d.error) && <Text>{s(d.error)!}</Text>,
      };
    case 'run.cancelled':
      return {
        icon: Ban,
        title: 'Run cancelled',
        meta: <Meta items={[d.requested === true ? 'requested by the owner' : d.requested === false ? 'parent run was cancelled' : null]} />,
      };
    case 'run.interrupted':
      return {
        icon: CirclePause,
        title: 'Run interrupted',
        emphasis: 'warning',
        meta: <Meta items={[s(d.reason), s(d.previous_status) && `was ${s(d.previous_status)}`]} />,
      };
    case 'step.started':
      return { icon: ListOrdered, title: `Step ${n(d.step) ?? ''}`, meta: <Meta items={[s(d.model)]} /> };

    // ---------------- runtime: model
    case 'model.request': {
      const tools = Array.isArray(d.tools) ? (d.tools as unknown[]) : [];
      return {
        icon: ArrowUpRight,
        title: 'Model request',
        meta: (
          <Meta
            items={[
              s(d.provider),
              s(d.model),
              n(d.attempt) && n(d.attempt)! > 1 ? `attempt ${n(d.attempt)}` : null,
              n(d.messages) !== undefined && `${n(d.messages)} messages`,
              `${tools.length} tools`,
            ]}
          />
        ),
        body: tools.length > 0 && <Collapsible label="Tools offered" value={tools} />,
      };
    }
    case 'model.response': {
      const cost = n(d.cost_usd);
      return {
        icon: ArrowDownLeft,
        title: 'Model response',
        meta: (
          <Meta
            items={[
              s(d.model),
              n(d.duration_ms) !== undefined && formatMs(n(d.duration_ms)),
              ...usageMeta(d),
              cost !== undefined ? `${formatCost(cost)}${d.cost_estimated === false ? '' : ' estimated'}` : 'cost unknown',
              s(d.stop_reason) && `stop: ${s(d.stop_reason)}`,
            ]}
          />
        ),
        body: s(d.cost_note) && <Text muted>{s(d.cost_note)!}</Text>,
      };
    }
    case 'model.retry':
      return {
        icon: RefreshCw,
        title: 'Model call retry',
        emphasis: 'warning',
        meta: <Meta items={[n(d.attempt) && `attempt ${n(d.attempt)} failed`, n(d.retry_in_s) !== undefined && `retry in ${n(d.retry_in_s)} s`]} />,
        body: s(d.error) && <Text>{s(d.error)!}</Text>,
      };
    case 'model.error':
      return {
        icon: TriangleAlert,
        title: 'Model call failed',
        emphasis: 'error',
        meta: <Meta items={[n(d.attempt) && `attempt ${n(d.attempt)}`, d.final === true && 'final']} />,
        body: s(d.error) && <Text>{s(d.error)!}</Text>,
      };

    // ---------------- runtime: permissions & approvals
    case 'tool.permission':
      return {
        icon: Shield,
        title: (<>Permission check <Mono>{s(d.tool) ?? ''}</Mono></>),
        meta: (
          <span className="inline-flex items-center gap-1.5">
            <PermissionBadge permission={s(d.decision)} />
            <Meta items={[s(d.rule) && `${s(d.rule)} rule`]} />
          </span>
        ),
        emphasis: d.decision === 'deny' ? 'error' : undefined,
      };
    case 'approval.requested':
      return { icon: ShieldQuestion, title: (<>Approval requested <Mono>{s(d.tool) ?? ''}</Mono></>), emphasis: 'warning' };
    case 'approval.decided': {
      const decision = s(d.decision);
      return {
        icon: ShieldCheck,
        title: event.source === 'user' ? 'Owner decision' : 'Approval closed',
        meta: (
          <span className="inline-flex items-center gap-1.5">
            <StatusBadge status={decision} />
            {s(d.tool) && <Mono className="text-xs">{s(d.tool)}</Mono>}
          </span>
        ),
        body: s(d.note) && <Text muted>{`Note: ${s(d.note)}`}</Text>,
        emphasis: decision === 'approved' ? 'success' : 'warning',
      };
    }
    case 'run.cancel_requested':
      return { icon: Ban, title: 'Cancellation requested', meta: <Meta items={[s(d.actor) && `by ${s(d.actor)}`]} /> };

    // ---------------- runtime: delegation & teams
    case 'delegation.started':
      return {
        icon: GitBranch,
        title: (<>Delegated to <Mono>{s(d.agent_id) ?? 'agent'}</Mono></>),
        meta: s(d.child_run_id) && <RunLink runId={s(d.child_run_id)!} label="Child run" />,
        body: (
          <>
            {s(d.role) && <Text muted>{`Responsibility: ${s(d.role)}`}</Text>}
            <Collapsible label="Task" value={s(d.task)} />
          </>
        ),
      };
    case 'delegation.completed':
      return {
        icon: GitMerge,
        title: (<>Delegation returned from <Mono>{s(d.agent_id) ?? 'agent'}</Mono></>),
        meta: (
          <span className="inline-flex flex-wrap items-center gap-2">
            <StatusBadge status={s(d.status)} />
            {s(d.child_run_id) && <RunLink runId={s(d.child_run_id)!} label="Child run" />}
          </span>
        ),
        body: <Collapsible label="Output preview" value={s(d.output_preview)} />,
      };
    case 'team.member_started':
      return {
        icon: Users,
        title: (<>Team member started <Mono>{s(d.agent) ?? ''}</Mono></>),
        meta: <Meta items={[n(d.index) !== undefined && `#${(n(d.index) ?? 0) + 1}`]} />,
        body: s(d.responsibility) && <Text muted>{`Responsibility: ${s(d.responsibility)}`}</Text>,
      };
    case 'team.member_completed':
      return {
        icon: Users,
        title: (<>Team member finished <Mono>{s(d.agent) ?? ''}</Mono></>),
        meta: (
          <span className="inline-flex flex-wrap items-center gap-2">
            <StatusBadge status={s(d.status)} />
            {s(d.run_id) && <RunLink runId={s(d.run_id)!} label="Member run" />}
          </span>
        ),
      };
    case 'team.member_skipped':
      return {
        icon: Users,
        title: (<>Team member skipped <Mono>{s(d.agent) ?? ''}</Mono></>),
        meta: <Meta items={[s(d.reason)]} />,
      };
    case 'limit.exceeded':
      return {
        icon: Gauge,
        title: (<>Limit exceeded <Mono>{s(d.limit) ?? ''}</Mono></>),
        emphasis: 'error',
        meta: <Meta items={[d.value !== undefined && `value ${String(d.value)}`, d.max !== undefined && `max ${String(d.max)}`]} />,
      };
    case 'usage.limit':
      return {
        icon: Gauge,
        title: d.status === 'warn' ? 'Approaching your plan’s usage limit' : 'Subscription usage limit',
        emphasis: d.status === 'warn' ? undefined : 'error',
        meta: (
          <Meta
            items={[
              s(d.window),
              typeof d.utilization === 'number' && `${Math.round(d.utilization * 100)}% used`,
              s(d.resets_at) && `resets ${s(d.resets_at)}`,
            ]}
          />
        ),
        body: s(d.message) ? <Text muted>{`${s(d.message)}`}</Text> : undefined,
      };
    case 'runtime.note':
      return {
        icon: Info,
        title: s(d.message) ?? 'Note',
        body: (
          <>
            {Array.isArray(d.errors) && <Collapsible label={`Details (${(d.errors as unknown[]).length})`} value={d.errors} open />}
            {Array.isArray(d.tools) && <Collapsible label="Tools" value={d.tools} />}
            {s(d.model) && <Text muted>{`Model: ${s(d.model)}`}</Text>}
          </>
        ),
      };
    default:
      return { icon: Info, title: <Mono>{event.type}</Mono>, body: <Collapsible label="Data" value={d} /> };
  }
}

const EMPHASIS_TEXT: Record<Exclude<Emphasis, undefined>, string> = {
  error: 'text-red-700 dark:text-red-300',
  success: 'text-emerald-700 dark:text-emerald-300',
  warning: 'text-amber-700 dark:text-amber-300',
};

// ------------------------------------------------------------------ rows

export function EventRow({ event, nested = false }: { event: RunEvent; nested?: boolean }) {
  const { onInspect } = useContext(TimelineContext);
  const style = sourceStyle(event.source);
  const description = describeEvent(event);
  const Icon = description.icon;
  return (
    <li
      data-source={event.source}
      data-type={event.type}
      className={cx('border-l-2 py-2 pl-3', style.rail, nested && 'py-1.5')}
    >
      <div className="flex items-start gap-2">
        <Icon className={cx('mt-0.5 h-4 w-4 shrink-0', description.emphasis ? EMPHASIS_TEXT[description.emphasis] : style.text)} aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <SourceChip source={event.source} />
            <span
              className={cx(
                'text-sm font-medium',
                description.emphasis ? EMPHASIS_TEXT[description.emphasis] : 'text-zinc-900 dark:text-zinc-100',
              )}
            >
              {description.title}
            </span>
            {description.meta}
            <span className="ml-auto flex items-center gap-1">
              <time
                dateTime={event.ts}
                title={formatDateTime(event.ts)}
                className="text-xs tabular-nums text-zinc-400 dark:text-zinc-500"
              >
                {formatTime(event.ts)}
              </time>
              <IconButton label={`Inspect raw event ${event.id}`} className="h-6 w-6" onClick={() => onInspect(event)}>
                <Braces className="h-3.5 w-3.5" />
              </IconButton>
            </span>
          </div>
          {description.body}
        </div>
      </div>
    </li>
  );
}

const CARD_STATE: Record<ToolCardState, { label: string; tone: Parameters<typeof Badge>[0]['tone'] }> = {
  proposed: { label: 'Requested', tone: 'gray' },
  approved: { label: 'Approved', tone: 'green' },
  awaiting_approval: { label: 'Awaiting approval', tone: 'amber' },
  denied: { label: 'Denied by policy', tone: 'red' },
  not_approved: { label: 'Not approved', tone: 'red' },
  running: { label: 'Running', tone: 'blue' },
  completed: { label: 'Completed', tone: 'green' },
  failed: { label: 'Failed', tone: 'red' },
};

function ApprovalFromEvent({ event, card }: { event: RunEvent; card: ToolItem }) {
  const { approvals } = useContext(TimelineContext);
  const d = event.data;
  const id = s(d.approval_id) ?? '';
  const record = approvals.get(id);
  const decided = card.events.find((e) => e.type === 'approval.decided' && e.data.approval_id === id);
  const status = (record?.status ?? (decided ? s(decided.data.decision) : 'pending')) as ApprovalStatus;
  return (
    <li data-source={event.source} data-type={event.type} className={cx('border-l-2 py-2 pl-3', sourceStyle(event.source).rail)}>
      <div className="mb-1.5 flex items-center gap-2">
        <SourceChip source={event.source} />
        <span className="text-sm font-medium text-amber-700 dark:text-amber-300">Approval requested</span>
        <span className="ml-auto flex items-center gap-1">
          <time dateTime={event.ts} className="text-xs tabular-nums text-zinc-400 dark:text-zinc-500">
            {formatTime(event.ts)}
          </time>
          <InspectButton event={event} />
        </span>
      </div>
      <ApprovalCard
        approval={{
          id,
          tool: record?.tool ?? s(d.tool) ?? card.tool,
          args: (record?.args ?? d.args ?? null) as Approval['args'],
          risk: record?.risk ?? s(d.risk) ?? '',
          reason: record?.reason ?? s(d.reason) ?? null,
          status,
          run_id: event.run_id,
          root_run_id: event.root_run_id,
          expires_at: record?.expires_at,
          decided_at: record?.decided_at,
          note: record?.note,
        }}
      />
    </li>
  );
}

function InspectButton({ event }: { event: RunEvent }) {
  const { onInspect } = useContext(TimelineContext);
  return (
    <IconButton label={`Inspect raw event ${event.id}`} className="h-6 w-6" onClick={() => onInspect(event)}>
      <Braces className="h-3.5 w-3.5" />
    </IconButton>
  );
}

export function ToolCallCard({ item }: { item: ToolItem }) {
  const state = toolCardState(item);
  const finished = [...item.events].reverse().find((e) => e.type === 'tool.completed' || e.type === 'tool.failed');
  const permission = [...item.events].reverse().find((e) => e.type === 'tool.permission');
  const duration = finished ? n(finished.data.duration_ms) : undefined;
  const badge = CARD_STATE[state];
  return (
    <li data-kind="tool-call" className="py-1.5">
      <div className="rounded-md border border-zinc-200 bg-zinc-50/60 dark:border-zinc-800 dark:bg-zinc-950/40">
        <div className="flex flex-wrap items-center gap-2 border-b border-zinc-200 px-3 py-2 dark:border-zinc-800">
          <Wrench className="h-4 w-4 text-zinc-500" aria-hidden />
          <span className="text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Tool call</span>
          <Mono className="font-semibold text-zinc-900 dark:text-zinc-100">{item.tool || 'unknown tool'}</Mono>
          <Badge tone={badge.tone} dot>
            {badge.label}
          </Badge>
          {permission && <PermissionBadge permission={s(permission.data.decision)} />}
          {duration !== undefined && <span className="text-xs tabular-nums text-zinc-500">{formatMs(duration)}</span>}
          <Mono className="ml-auto text-[0.7rem] text-zinc-400" >{item.toolCallId}</Mono>
        </div>
        <ul className="space-y-0.5 px-3 py-1">
          {item.events.map((event) =>
            event.type === 'approval.requested' ? (
              <ApprovalFromEvent key={event.id} event={event} card={item} />
            ) : (
              <EventRow key={event.id} event={event} nested />
            ),
          )}
        </ul>
      </div>
    </li>
  );
}

// ------------------------------------------------------------------ groups

function GroupHeader({ group }: { group: TimelineGroup }) {
  const step = group.stepEvent;
  return (
    <div className="flex items-center gap-2 py-1.5">
      <span className="text-xs font-semibold uppercase tracking-wide text-zinc-700 dark:text-zinc-300">{group.label}</span>
      {step && s(step.data.model) && <Mono className="text-xs text-zinc-500">{s(step.data.model)}</Mono>}
      <span className="h-px flex-1 bg-zinc-200 dark:bg-zinc-800" aria-hidden />
      {step && (
        <span className="flex items-center gap-1">
          <time dateTime={step.ts} className="text-xs tabular-nums text-zinc-400">
            {formatTime(step.ts)}
          </time>
          <InspectButton event={step} />
        </span>
      )}
    </div>
  );
}

export function TimelineGroups({ groups }: { groups: TimelineGroup[] }) {
  return (
    <div className="space-y-3">
      {groups.map((group) => (
        <section key={group.key} aria-label={group.label} data-group={group.label}>
          <GroupHeader group={group} />
          {group.items.length > 0 ? (
            <ol className="mt-1 space-y-0.5">
              {group.items.map((item) =>
                item.kind === 'tool' ? <ToolCallCard key={item.key} item={item} /> : <EventRow key={item.key} event={item.event} />,
              )}
            </ol>
          ) : (
            <p className="py-2 pl-3 text-xs text-zinc-400">Waiting for the model…</p>
          )}
        </section>
      ))}
    </div>
  );
}

/** Timeline of one run (events already filtered to that run). */
export function Timeline({ events }: { events: RunEvent[] }) {
  const groups = useMemo(() => buildTimeline(events), [events]);
  if (events.length === 0) {
    return <p className="py-6 text-center text-sm text-zinc-500 dark:text-zinc-400">No events yet.</p>;
  }
  return <TimelineGroups groups={groups} />;
}

export function SourceLegend() {
  return (
    <div className="flex flex-wrap items-center gap-2" aria-label="Event sources">
      {(['agent', 'tool', 'runtime', 'user'] as const).map((source) => (
        <span key={source} className="inline-flex items-center gap-1.5 text-xs text-zinc-500 dark:text-zinc-400">
          <SourceChip source={source} />
          <span className="hidden md:inline">{sourceStyle(source).description.split(':')[0]}</span>
        </span>
      ))}
    </div>
  );
}

