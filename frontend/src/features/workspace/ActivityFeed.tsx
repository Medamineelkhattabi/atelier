// "Activity": what happened, in order, one line per event, built from the task's real events.
// New events appear as they arrive (the list is a polite live region); nothing is shown or
// animated when nothing happened. "Show every action" adds tool-level actions. A second line only
// appears when it adds something (a reason, an error, your note); otherwise it is in the tooltip.

import { useId, useMemo, useState } from 'react';
import { Ban, CircleCheck, CircleX, Flag, Hand, ListChecks, MessageSquare, Pause, Play, RotateCcw, Send, ShieldCheck, ShieldQuestion, ShieldX, SkipForward, TriangleAlert, Wrench } from 'lucide-react';
import type { RunEvent } from '../../api/types';
import { Card, CardHeader, ErrorState, Toggle } from '../../components/ui';
import { cx } from '../../lib/cx';
import { formatDateTime, formatTime } from '../../lib/format';
import { AgentAvatar } from './agentAvatar';
import { buildActivity, type ActivityContext, type ActivityItem, type ActivityKind } from './activity';

const ICON: Record<ActivityKind, typeof Flag> = {
  start: Play,
  plan: ListChecks,
  'step-start': Play,
  handoff: Send,
  'step-done': CircleCheck,
  'step-failed': CircleX,
  'step-skipped': SkipForward,
  retry: RotateCcw,
  approval: ShieldQuestion,
  approved: ShieldCheck,
  declined: ShieldX,
  pause: Pause,
  resume: Play,
  stop: Ban,
  done: Flag,
  failed: CircleX,
  interrupted: TriangleAlert,
  limit: Hand,
  action: Wrench,
  'action-failed': Wrench,
  message: MessageSquare,
};

const ICON_TONE: Partial<Record<ActivityKind, string>> = {
  'step-done': 'text-emerald-600 dark:text-emerald-400',
  done: 'text-emerald-600 dark:text-emerald-400',
  approved: 'text-emerald-600 dark:text-emerald-400',
  'step-failed': 'text-red-600 dark:text-red-400',
  failed: 'text-red-600 dark:text-red-400',
  'action-failed': 'text-red-600 dark:text-red-400',
  declined: 'text-red-600 dark:text-red-400',
  approval: 'text-amber-600 dark:text-amber-400',
  pause: 'text-amber-600 dark:text-amber-400',
  limit: 'text-amber-600 dark:text-amber-400',
  interrupted: 'text-amber-600 dark:text-amber-400',
  handoff: 'text-teal-600 dark:text-teal-400',
};

const PAGE = 60;

/** Kinds whose second line adds information the step cards do not already show. */
const DETAIL_SHOWN: ReadonlySet<ActivityKind> = new Set<ActivityKind>([
  'retry',
  'step-failed',
  'step-skipped',
  'approval',
  'approved',
  'declined',
  'failed',
  'limit',
  'action-failed',
]);

export function ActivityFeed({
  events,
  context,
  loading,
  error,
  onRetry,
  className,
}: {
  events: RunEvent[];
  context: ActivityContext;
  loading?: boolean;
  error?: unknown;
  onRetry?: () => void;
  className?: string;
}) {
  const [everyAction, setEveryAction] = useState(false);
  const [limit, setLimit] = useState(PAGE);
  const listId = useId();
  const items = useMemo(() => buildActivity(events, context), [events, context]);
  const shown = useMemo(() => items.filter((item) => everyAction || !item.everyAction), [items, everyAction]);
  const hidden = Math.max(0, shown.length - limit);
  const visible = hidden ? shown.slice(hidden) : shown;

  return (
    <Card className={className}>
      <CardHeader title="Activity" actions={<Toggle checked={everyAction} onChange={setEveryAction} label="Show every action" showLabel />} />
      <div className="px-4 py-3">
        {error ? <ErrorState compact error={error} title="The activity could not be loaded" onRetry={onRetry} /> : null}
        {hidden > 0 && (
          <button
            type="button"
            onClick={() => setLimit((v) => v + PAGE)}
            aria-controls={listId}
            className="mb-2 rounded text-xs font-medium text-accent-700 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 dark:text-accent-300"
          >
            Show earlier activity ({hidden})
          </button>
        )}
        <div role="log" aria-label="Activity" aria-live="polite">
          {visible.length === 0 ? (
            !error && <p className="py-4 text-sm text-zinc-500 dark:text-zinc-400">{loading ? 'Loading the activity…' : 'Nothing has been recorded yet.'}</p>
          ) : (
            <ol id={listId} className="space-y-0">
              {visible.map((item, index) => (
                <ActivityRow key={`${item.id}-${index}`} item={item} />
              ))}
            </ol>
          )}
        </div>
      </div>
    </Card>
  );
}

function ActivityRow({ item }: { item: ActivityItem }) {
  const Icon = ICON[item.kind];
  const showDetail = !!item.detail && DETAIL_SHOWN.has(item.kind);
  return (
    <li
      className={cx('flex gap-2.5 border-l-2 py-1 pl-3', item.everyAction ? 'border-zinc-100 dark:border-zinc-800' : 'border-zinc-200 dark:border-zinc-700')}
      title={item.detail && !showDetail ? item.detail : undefined}
    >
      <span className="shrink-0">
        {item.actor && item.actor !== 'you' ? (
          <AgentAvatar agentId={item.actor.agentId} name={item.actor.name} size="sm" />
        ) : (
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-zinc-100 dark:bg-zinc-800" aria-hidden>
            <Icon className={cx('h-3.5 w-3.5', ICON_TONE[item.kind] ?? 'text-zinc-500 dark:text-zinc-400')} />
          </span>
        )}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <p className={cx('min-w-0 flex-1 break-words text-sm', item.everyAction ? 'text-zinc-600 dark:text-zinc-400' : 'text-zinc-900 dark:text-zinc-100')}>
            {item.actor && item.actor !== 'you' && <Icon className={cx('mr-1 inline h-3.5 w-3.5 align-[-2px]', ICON_TONE[item.kind] ?? 'text-zinc-400')} aria-hidden />}
            {item.text}
          </p>
          <time dateTime={item.ts} title={formatDateTime(item.ts)} className="shrink-0 text-[0.7rem] tabular-nums text-zinc-400 dark:text-zinc-500">
            {formatTime(item.ts)}
          </time>
        </div>
        {showDetail && <p className="line-clamp-2 break-words text-xs text-zinc-500 dark:text-zinc-400">{item.detail}</p>}
      </div>
    </li>
  );
}
