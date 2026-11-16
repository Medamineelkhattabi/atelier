// Live Workspace without a task selected: the tasks in progress and recently finished in the
// selected project (every task, including those done by one team member), and how to start one.
// Lists refresh live: the global stream invalidates them when tasks start, change or end.

import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { CirclePause, Plus, ShieldQuestion } from 'lucide-react';
import { listAgents, listExecutions, listRuns } from '../../api/endpoints';
import { qk } from '../../api/keys';
import type { ExecutionSummary, RunListParams, RunSummary } from '../../api/types';
import { Badge, ButtonLink, Card, EmptyState, ErrorState, LoadingState } from '../../components/ui';
import { formatRelative } from '../../lib/format';
import { useNow } from '../../lib/hooks';
import { memberName, plainTaskText, workStatus } from '../../lib/plain';
import { ProjectFilterNote, projectLabel, useProjectNames } from '../projects/ProjectContext';
import { AgentAvatar } from './agentAvatar';
import { StatusPill } from './StepsView';
import type { Names } from './steps';

export const ACTIVE_STATUSES = 'queued,running,waiting_approval';
export const FINISHED_STATUSES = 'completed,failed,cancelled,interrupted';

export function TaskLanding({ projectId }: { projectId: string | null }) {
  const agents = useQuery({ queryKey: qk.agents, queryFn: listAgents, staleTime: 60_000 });
  const names = useMemo<Names>(() => Object.fromEntries((agents.data?.items ?? []).map((a) => [a.id, { name: a.name }])), [agents.data]);
  const executionParams = { project_id: projectId ?? undefined, limit: 100 };
  const executions = useQuery({
    queryKey: qk.executionList(executionParams),
    queryFn: () => listExecutions(executionParams),
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
  });
  const byRun = useMemo(() => new Map((executions.data?.items ?? []).map((e) => [e.run_id, e])), [executions.data]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <ProjectFilterNote />
        <ButtonLink to="/" variant="primary" size="md" icon={<Plus className="h-4 w-4" />} className="ml-auto">
          Start a new task
        </ButtonLink>
      </div>
      <TaskSection
        title="In progress"
        emptyTitle="Nothing in progress right now"
        params={{ project_id: projectId ?? undefined, status: ACTIVE_STATUSES, root_only: true, limit: 30 }}
        byRun={byRun}
        names={names}
        showProject={!projectId}
      />
      <TaskSection
        title="Recently finished"
        emptyTitle="No finished task yet"
        params={{ project_id: projectId ?? undefined, status: FINISHED_STATUSES, root_only: true, limit: 10 }}
        byRun={byRun}
        names={names}
        showProject={!projectId}
      />
    </div>
  );
}

function TaskSection({
  title,
  emptyTitle,
  emptyText,
  params,
  byRun,
  names,
  showProject,
}: {
  title: string;
  emptyTitle: string;
  emptyText?: string;
  params: RunListParams;
  byRun: Map<string, ExecutionSummary>;
  names: Names;
  showProject: boolean;
}) {
  const query = useQuery({
    queryKey: qk.runList(params),
    queryFn: () => listRuns(params),
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
  });
  const projectNames = useProjectNames();
  const now = useNow(30_000);
  const headingId = `tasks-${title.toLowerCase().replace(/\s+/g, '-')}`;
  const items = query.data?.items ?? [];
  return (
    <section aria-labelledby={headingId}>
      <h2 id={headingId} className="mb-2 text-base font-semibold text-zinc-900 dark:text-zinc-50">
        {title}
      </h2>
      {query.isPending ? (
        <LoadingState label="Loading tasks…" />
      ) : query.isError ? (
        <ErrorState compact error={query.error} title="Tasks could not be loaded" onRetry={() => void query.refetch()} />
      ) : items.length === 0 ? (
        <Card>
          <EmptyState title={emptyTitle} description={emptyText} />
        </Card>
      ) : (
        <ul className="grid gap-2 lg:grid-cols-2" aria-label={title}>
          {items.map((run) => (
            <li key={run.id} className="min-w-0">
              <TaskItem run={run} execution={byRun.get(run.id)} names={names} now={now} projectName={showProject && run.project_id ? projectLabel(run.project_id, projectNames) : null} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Who works on a task: the team members seen in its tree, else who it was given to. */
function membersOf(run: RunSummary, execution: ExecutionSummary | undefined, names: Names): { id: string; name: string }[] {
  const seen = execution?.agents ?? [];
  // The one the task was given to comes first.
  const ids = run.agent_id ? [run.agent_id, ...seen.filter((id) => id !== run.agent_id)] : [...seen];
  return ids.map((id) => ({ id, name: memberName(id, names) }));
}

function TaskItem({ run, execution, names, now, projectName }: { run: RunSummary; execution?: ExecutionSummary; names: Names; now: number; projectName: string | null }) {
  const paused = execution?.paused ?? false;
  const status = workStatus(run.status, { paused });
  const members = membersOf(run, execution, names);
  const tasks = execution?.tasks;
  const finished = !['queued', 'running', 'waiting_approval'].includes(run.status);
  const approvals = execution?.pending_approvals ?? 0;
  const text = plainTaskText(run.task) || 'Untitled task';
  return (
    <Link
      to={`/workspace/${run.id}`}
      className="block h-full rounded-lg border border-zinc-200 bg-white px-3 py-3 text-sm shadow-sm transition-colors hover:border-zinc-300 hover:bg-zinc-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-zinc-700 dark:hover:bg-zinc-800/60"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <span className="line-clamp-2 min-w-0 flex-1 break-words font-medium text-zinc-900 dark:text-zinc-100">{text}</span>
        <StatusPill status={status} className="shrink-0" />
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-zinc-600 dark:text-zinc-400">
        {run.kind === 'team' && run.team_name && <span className="font-medium text-zinc-700 dark:text-zinc-300">Team “{run.team_name}”</span>}
        {members.length > 0 && (
          <span className="inline-flex min-w-0 items-center gap-1.5">
            <span className="flex -space-x-1.5" aria-hidden>
              {members.slice(0, 4).map((m) => (
                <AgentAvatar key={m.id} agentId={m.id} name={m.name} size="sm" />
              ))}
            </span>
            <span className="min-w-0 break-words">{members.map((m) => m.name).join(', ')}</span>
          </span>
        )}
        {tasks && tasks.total > 0 && (
          <span className="tabular-nums">
            {tasks.completed} of {tasks.total} step{tasks.total === 1 ? '' : 's'} done
          </span>
        )}
        {paused && !finished && (
          <Badge tone="amber">
            <CirclePause className="h-3 w-3" aria-hidden /> Paused
          </Badge>
        )}
        {approvals > 0 && (
          <Badge tone="amber">
            <ShieldQuestion className="h-3 w-3" aria-hidden />
            {approvals === 1 ? 'Needs your approval' : `${approvals} approvals waiting`}
          </Badge>
        )}
      </div>
      <p className="mt-1.5 text-[0.7rem] text-zinc-500 dark:text-zinc-400">
        {finished && run.finished_at ? `Ended ${formatRelative(run.finished_at, now)}` : `Started ${formatRelative(run.created_at, now)}`}
        {projectName && <> · {projectName}</>}
      </p>
    </Link>
  );
}
