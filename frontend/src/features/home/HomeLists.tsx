// Below the request on Home: what needs the owner, what is in progress, and the latest results.
// Everything comes from the API (runs and approvals), filtered by the selected project.

import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Check, ClipboardList, Play, ShieldQuestion, X } from 'lucide-react';
import { decideApproval, listApprovals, listRuns, resumeRun } from '../../api/endpoints';
import { qk } from '../../api/keys';
import type { Agent, Approval, RunListParams, RunSummary } from '../../api/types';
import { Button, ButtonLink, EmptyState, ErrorState, LoadingState } from '../../components/ui';
import { useToast } from '../../components/toast';
import { useNow } from '../../lib/hooks';
import { plainTaskText } from '../../lib/plain';
import { approvalWords } from '../approvals/approvalText';
import { TimeLeft } from '../approvals/ApprovalCard';
import { projectLabel, useProjectNames } from '../projects/ProjectContext';
import { TaskItem } from '../work/TaskItem';

type Agents = Agent[] | undefined;

function Section({ id, title, children, action }: { id: string; title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section aria-labelledby={id} className="min-w-0">
      <div className="mb-1.5 flex flex-wrap items-end justify-between gap-2">
        <h2 id={id} className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">
          {title}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}

const LIST = 'divide-y divide-zinc-100 overflow-hidden rounded-lg border border-zinc-200 bg-white dark:divide-zinc-800 dark:border-zinc-800 dark:bg-zinc-900';

function useRoots(params: RunListParams, refetchInterval?: number) {
  return useQuery({ queryKey: qk.runList(params), queryFn: () => listRuns(params), refetchInterval });
}

// ------------------------------------------------------------------ needs your attention

export function NeedsAttention({ projectId, agents }: { projectId: string | null; agents: Agents }) {
  const approvals = useQuery({ queryKey: qk.approvalList('pending'), queryFn: () => listApprovals('pending'), refetchInterval: 15_000 });
  const interrupted = useRoots({ project_id: projectId ?? undefined, status: 'interrupted', root_only: true, limit: 5 });
  const now = useNow(30_000);
  const names = useProjectNames();
  const all = approvals.data?.items ?? [];
  const shown = projectId ? all.filter((a) => a.project_id === projectId) : all;
  const elsewhere = all.length - shown.length;
  const stopped = interrupted.data?.items ?? [];
  const loading = approvals.isPending || interrupted.isPending;
  const nothing = !loading && shown.length === 0 && stopped.length === 0;

  return (
    <Section id="home-attention" title="Needs your attention">
      {approvals.isError && <ErrorState compact error={approvals.error} title="Approval requests could not be loaded." onRetry={() => void approvals.refetch()} />}
      {interrupted.isError && <ErrorState compact error={interrupted.error} title="Interrupted tasks could not be loaded." onRetry={() => void interrupted.refetch()} />}
      {loading ? (
        <LoadingState label="Checking what needs you…" />
      ) : nothing ? (
        <p className="rounded-lg border border-dashed border-zinc-300 px-4 py-2.5 text-sm text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">Nothing needs you right now.</p>
      ) : (
        <ul className={LIST} aria-label="Things that need your attention">
          {shown.map((approval) => (
            <ApprovalItem key={approval.id} approval={approval} agents={agents} projectName={projectId ? null : approval.project_id ? projectLabel(approval.project_id, names) : null} />
          ))}
          {stopped.map((run) => (
            <TaskItem
              key={run.id}
              run={run}
              agents={agents}
              now={now}
              projectName={projectId ? null : run.project_id ? projectLabel(run.project_id, names) : null}
              actions={<ContinueButton run={run} />}
            />
          ))}
        </ul>
      )}
      {elsewhere > 0 && (
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
          {elsewhere} more request{elsewhere === 1 ? '' : 's'} waiting in other projects.{' '}
          <Link to="/approvals" className="font-medium text-accent-700 hover:underline dark:text-accent-300">
            See all approvals
          </Link>
        </p>
      )}
    </Section>
  );
}

function ApprovalItem({ approval, agents, projectName }: { approval: Approval; agents: Agents; projectName: string | null }) {
  const queryClient = useQueryClient();
  const { notify } = useToast();
  const words = approvalWords(approval, agents);
  const task = plainTaskText(approval.root_task ?? approval.run_task);
  const decide = useMutation({
    mutationFn: (approve: boolean) => decideApproval(approval.id, { approve }),
    onSuccess: (result) =>
      notify(result.status === 'approved' ? `Approved — ${words.who} goes ahead.` : `Rejected — ${words.who} will not do it and carries on without it.`),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: qk.approvals });
      void queryClient.invalidateQueries({ queryKey: [...qk.runs, 'list'] });
    },
  });
  // Something worth reading first (a command, a file's content, a message): review it on the Approvals page.
  const mustReview = !!words.action.preview;
  return (
    <li className="flex flex-wrap items-start gap-x-3 gap-y-2 px-4 py-2.5">
      <ShieldQuestion className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
      <div className="min-w-0 flex-1 basis-56">
        <p className="break-words text-sm text-zinc-900 dark:text-zinc-100">{words.sentence}</p>
        <p className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-zinc-600 dark:text-zinc-400">
          {task && <span className="min-w-0 break-words">For your task “{task.length > 70 ? `${task.slice(0, 69)}…` : task}”</span>}
          {projectName && <span>· {projectName}</span>}
          <TimeLeft expiresAt={approval.expires_at} />
        </p>
        {decide.isError && <ErrorState compact error={decide.error} title="Your decision was not recorded." />}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {!mustReview && (
          <>
            <Button size="xs" variant="success" icon={<Check className="h-3.5 w-3.5" />} loading={decide.isPending && decide.variables === true} disabled={decide.isPending} onClick={() => decide.mutate(true)} aria-label={`Approve: ${words.sentence}`}>
              Approve
            </Button>
            <Button size="xs" variant="danger" icon={<X className="h-3.5 w-3.5" />} loading={decide.isPending && decide.variables === false} disabled={decide.isPending} onClick={() => decide.mutate(false)} aria-label={`Reject: ${words.sentence}`}>
              Reject
            </Button>
          </>
        )}
        <ButtonLink to={`/approvals#approval-${approval.id}`} size="xs" variant={mustReview ? 'primary' : 'secondary'}>
          Review
        </ButtonLink>
      </div>
    </li>
  );
}

function ContinueButton({ run }: { run: RunSummary }) {
  const queryClient = useQueryClient();
  const { notify } = useToast();
  const resume = useMutation({
    mutationFn: () => resumeRun(run.id),
    onSuccess: () => {
      notify('Continuing where it stopped.');
      void queryClient.invalidateQueries({ queryKey: [...qk.runs, 'list'] });
    },
    onError: (error) => notify(`Could not continue: ${(error as Error).message}`, 'error'),
  });
  return (
    <Button size="xs" variant="primary" icon={<Play className="h-3.5 w-3.5" />} loading={resume.isPending} onClick={() => resume.mutate()}>
      Continue
    </Button>
  );
}

// ------------------------------------------------------------------ in progress

export function InProgress({ projectId, agents }: { projectId: string | null; agents: Agents }) {
  const runs = useRoots({ project_id: projectId ?? undefined, status: 'queued,running,waiting_approval', root_only: true, limit: 10 }, 15_000);
  const now = useNow(1000, (runs.data?.items.length ?? 0) > 0);
  const names = useProjectNames();
  if (runs.isPending) return null;
  if (runs.isError) {
    return (
      <Section id="home-active" title="In progress">
        <ErrorState compact error={runs.error} title="Tasks in progress could not be loaded." onRetry={() => void runs.refetch()} />
      </Section>
    );
  }
  if (runs.data.items.length === 0) return null;
  return (
    <Section id="home-active" title="In progress">
      <ul className={LIST}>
        {runs.data.items.map((run) => (
          <TaskItem key={run.id} run={run} agents={agents} now={now} projectName={projectId ? null : run.project_id ? projectLabel(run.project_id, names) : null} />
        ))}
      </ul>
    </Section>
  );
}

// ------------------------------------------------------------------ recent work

export function RecentWork({ projectId, agents }: { projectId: string | null; agents: Agents }) {
  const runs = useRoots({ project_id: projectId ?? undefined, status: 'completed,failed,cancelled', root_only: true, limit: 5 });
  const now = useNow(60_000);
  const names = useProjectNames();
  return (
    <Section
      id="home-recent"
      title="Recent work"
      action={
        <Link to="/work" className="inline-flex items-center gap-1 text-sm font-medium text-accent-700 hover:underline dark:text-accent-300">
          See all my work <ArrowRight className="h-3.5 w-3.5" aria-hidden />
        </Link>
      }
    >
      {runs.isPending ? (
        <LoadingState label="Loading your recent work…" />
      ) : runs.isError ? (
        <ErrorState compact error={runs.error} title="Your recent work could not be loaded." onRetry={() => void runs.refetch()} />
      ) : runs.data.items.length === 0 ? (
        <div className={LIST}>
          <EmptyState icon={<ClipboardList className="h-5 w-5" aria-hidden />} title="Nothing finished yet" />
        </div>
      ) : (
        <ul className={LIST}>
          {runs.data.items.map((run) => (
            <TaskItem key={run.id} run={run} agents={agents} now={now} projectName={projectId ? null : run.project_id ? projectLabel(run.project_id, names) : null} />
          ))}
        </ul>
      )}
    </Section>
  );
}
