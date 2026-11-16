// Approvals: what team members asked permission for. "Waiting for you" first, "Decided earlier" second.
// Filtered by the top-bar project, and never silently: requests elsewhere are counted.

import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ShieldCheck } from 'lucide-react';
import { listAgents, listApprovals } from '../api/endpoints';
import { qk } from '../api/keys';
import type { Approval } from '../api/types';
import { Page } from '../components/Page';
import { Alert, EmptyState, ErrorState, LoadingState, Tabs } from '../components/ui';
import { ApprovalCard } from '../features/approvals/ApprovalCard';
import { ProjectFilterNote, projectLabel, useProjectNames, useProjectSelection } from '../features/projects/ProjectContext';

type Tab = 'pending' | 'history';

/** Approvals of the selected project, and how many belong elsewhere (never hidden silently). */
export function splitByProject<T extends Pick<Approval, 'project_id'>>(items: T[], projectId: string | null): { shown: T[]; elsewhere: number } {
  if (!projectId) return { shown: items, elsewhere: 0 };
  const shown = items.filter((a) => a.project_id === projectId);
  return { shown, elsewhere: items.length - shown.length };
}

export function ApprovalsPage() {
  const [tab, setTab] = useState<Tab>('pending');
  const { projectId, setProjectId } = useProjectSelection();
  const names = useProjectNames();
  const location = useLocation();
  const agents = useQuery({ queryKey: qk.agents, queryFn: listAgents, staleTime: 60_000 });
  const pending = useQuery({ queryKey: qk.approvalList('pending'), queryFn: () => listApprovals('pending'), refetchInterval: 15_000 });
  const history = useQuery({ queryKey: qk.approvalList('all'), queryFn: () => listApprovals('all', 500), enabled: tab === 'history' });
  const pendingView = splitByProject(pending.data?.items ?? [], projectId);
  const historyView = splitByProject((history.data?.items ?? []).filter((a) => a.status !== 'pending'), projectId);
  const agentItems = agents.data?.items ?? [];

  // Home links to one request (/approvals#approval-<id>): bring it into view once it is listed.
  const target = location.hash.startsWith('#approval-') ? location.hash.slice(1) : null;
  useEffect(() => {
    if (!target || !pending.data) return;
    const element = document.getElementById(target);
    if (!element) return;
    element.scrollIntoView?.({ block: 'start' });
    element.focus({ preventScroll: true });
  }, [target, pending.data]);

  const projectOf = (approval: Approval) => (approval.project_id ? projectLabel(approval.project_id, names) : null);

  return (
    <Page
      title="Approvals"
      description="Nothing happens until you decide."
      help={
        <p>
          <span className="font-medium">Approve</span> lets that one action happen. <span className="font-medium">Reject</span> stops it and the
          work carries on without it. Unanswered requests expire and are not done.
        </p>
      }
    >
      <div className="mx-auto max-w-5xl space-y-4">
        <ProjectFilterNote />
        <Tabs<Tab>
          label="Approvals"
          value={tab}
          onChange={setTab}
          tabs={[
            { id: 'pending', label: 'Waiting for you', count: pending.data ? pendingView.shown.length : undefined },
            { id: 'history', label: 'Decided earlier' },
          ]}
        />
        {tab === 'pending' && pendingView.elsewhere > 0 && (
          <Alert tone="amber" title={`${pendingView.elsewhere} more request${pendingView.elsewhere === 1 ? '' : 's'} waiting in other projects or outside any project`}>
            <button type="button" className="rounded font-medium underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500" onClick={() => setProjectId(null)}>
              Show all projects
            </button>
          </Alert>
        )}
        {tab === 'pending' &&
          (pending.isPending ? (
            <LoadingState label="Loading the requests…" />
          ) : pending.isError ? (
            <ErrorState error={pending.error} title="The requests could not be loaded." onRetry={() => void pending.refetch()} />
          ) : pendingView.shown.length === 0 ? (
            <div className="rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
              <EmptyState
                icon={<ShieldCheck className="h-5 w-5" aria-hidden />}
                title="Nothing is waiting for you"
                description="Sensitive actions ask here first."
              />
            </div>
          ) : (
            <ul className="space-y-3" aria-label="Requests waiting for you">
              {pendingView.shown.map((approval) => (
                <li key={approval.id} id={`approval-${approval.id}`} tabIndex={-1} className="rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500">
                  <ApprovalCard approval={approval} showRun agents={agentItems} projectName={projectId ? null : projectOf(approval)} />
                </li>
              ))}
            </ul>
          ))}
        {tab === 'history' &&
          (history.isPending ? (
            <LoadingState label="Loading earlier decisions…" />
          ) : history.isError ? (
            <ErrorState error={history.error} title="Earlier decisions could not be loaded. Try again." onRetry={() => void history.refetch()} />
          ) : historyView.shown.length === 0 ? (
            <div className="rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
              <EmptyState
                title={historyView.elsewhere ? 'No earlier decision in this project' : 'No earlier decision yet'}
              />
            </div>
          ) : (
            <ul className="space-y-3" aria-label="Decided earlier">
              {historyView.shown.map((approval) => (
                <li key={approval.id}>
                  <ApprovalCard approval={approval} showRun agents={agentItems} projectName={projectId ? null : projectOf(approval)} collapsePreviewWhenDecided />
                </li>
              ))}
            </ul>
          ))}
      </div>
    </Page>
  );
}
