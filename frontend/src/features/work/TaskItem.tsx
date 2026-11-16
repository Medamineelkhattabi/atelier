// One task in a list (Home, My Work): the owner's words, its status in plain words, who works on it,
// the project, when and how long. The whole row opens the task in the Live Workspace; actions stay
// clickable above it.

import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { CornerDownRight } from 'lucide-react';
import type { Agent, RunSummary } from '../../api/types';
import { Badge } from '../../components/ui';
import { cx } from '../../lib/cx';
import { formatDateTime, formatRelative } from '../../lib/format';
import { VERDICT_LABEL, plainTaskText, workStatus } from '../../lib/plain';
import { taskDuration, taskWho } from './taskInfo';

export function TaskItem({
  run,
  agents,
  projectName,
  now,
  actions,
  paused = false,
}: {
  run: RunSummary;
  agents: Pick<Agent, 'id' | 'name'>[] | undefined;
  /** Shown when the list mixes projects; omit it when the list is already filtered by project. */
  projectName?: string | null;
  now: number;
  actions?: ReactNode;
  paused?: boolean;
}) {
  const status = workStatus(run.status, { paused });
  const text = plainTaskText(run.task) || 'Task without a description';
  const duration = taskDuration(run, now);
  const facts = [taskWho(run, agents), projectName, duration].filter(Boolean) as string[];
  const verdict = run.status === 'completed' && run.verdict ? VERDICT_LABEL[run.verdict] : null;
  return (
    <li className="relative flex flex-wrap items-start gap-x-3 gap-y-1.5 px-4 py-2.5 hover:bg-zinc-50 focus-within:bg-zinc-50 dark:hover:bg-zinc-800/40 dark:focus-within:bg-zinc-800/40">
      <div className="min-w-0 flex-1 basis-56">
        <Link
          to={`/workspace/${run.id}`}
          className={cx(
            'line-clamp-2 break-words text-sm font-medium text-zinc-900 dark:text-zinc-100',
            'after:absolute after:inset-0 after:rounded-md focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-accent-500',
          )}
        >
          {text}
        </Link>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-zinc-500 dark:text-zinc-400">
          {facts.map((fact, index) => (
            <span key={index} className="min-w-0 break-words">
              {index > 0 && <span aria-hidden>· </span>}
              {fact}
            </span>
          ))}
          <span>
            {facts.length > 0 && <span aria-hidden>· </span>}
            <time dateTime={run.created_at} title={formatDateTime(run.created_at)}>
              {formatRelative(run.created_at, now)}
            </time>
          </span>
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {run.follow_up_of && (
          <Badge tone="gray" title="Continues an earlier task">
            <CornerDownRight className="h-3 w-3" aria-hidden />
            follow-up
          </Badge>
        )}
        {run.provider === 'scripted' && (
          <Badge tone="violet" title="Test mode: the answers came from a script, not an AI model.">
            Test mode
          </Badge>
        )}
        {verdict ? (
          <Badge tone={verdict.tone} dot title={verdict.hint}>
            {verdict.label}
          </Badge>
        ) : (
          <Badge tone={status.tone} dot title={status.hint}>
            {status.label}
          </Badge>
        )}
        {actions && <div className="relative z-10 flex flex-wrap items-center gap-1.5">{actions}</div>}
      </div>
    </li>
  );
}
