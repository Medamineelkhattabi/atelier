// My Work: everything the owner asked for, newest first, with plain statuses. Filters live in the
// address bar (?status=<filter>&q=…), the project comes from the top bar.

import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ClipboardList, Play, RotateCcw, Search, Trash2 } from 'lucide-react';
import { deleteRun, listAgents, listRuns, resumeRun } from '../api/endpoints';
import { qk } from '../api/keys';
import type { RunListParams, RunSummary } from '../api/types';
import { Page } from '../components/Page';
import { Button, ButtonLink, ConfirmDialog, EmptyState, ErrorState, IconButton, Input, LoadingState, Spinner } from '../components/ui';
import { useToast } from '../components/toast';
import { ProjectFilterNote, projectLabel, useProjectNames, useProjectSelection } from '../features/projects/ProjectContext';
import { TaskItem } from '../features/work/TaskItem';
import { filterStatuses, homeLink } from '../features/work/taskInfo';
import { cx } from '../lib/cx';
import { useDebounced, useNow } from '../lib/hooks';
import { WORK_FILTERS, plainTaskText } from '../lib/plain';
import { isActive } from '../lib/status';

const PAGE_SIZE = 20;

export function MyWorkPage() {
  const [params, setParams] = useSearchParams();
  const filter = WORK_FILTERS.some((f) => f.id === params.get('status')) ? params.get('status')! : 'all';
  const [search, setSearch] = useState(params.get('q') ?? '');
  const q = useDebounced(search.trim(), 300);
  const [pages, setPages] = useState(1);
  const { projectId } = useProjectSelection();
  const names = useProjectNames();

  const setParam = (key: string, value: string) =>
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        if (value) next.set(key, value);
        else next.delete(key);
        return next;
      },
      { replace: true },
    );

  useEffect(() => {
    if ((params.get('q') ?? '') !== q) setParam('q', q);
    // Only the debounced search goes into the address bar.
  }, [q]);
  // Another filter, search or project starts again from the newest tasks.
  useEffect(() => setPages(1), [filter, q, projectId]);

  const query: RunListParams = {
    project_id: projectId ?? undefined,
    status: filterStatuses(filter) || undefined,
    q: q || undefined,
    root_only: true,
    limit: PAGE_SIZE * pages,
  };
  const runs = useQuery({ queryKey: qk.runList(query), queryFn: () => listRuns(query), placeholderData: keepPreviousData });
  const agents = useQuery({ queryKey: qk.agents, queryFn: listAgents, staleTime: 60_000 });
  const items = runs.data?.items ?? [];
  const now = useNow(1000, items.some((r) => isActive(r.status)));
  const [toDelete, setToDelete] = useState<RunSummary | null>(null);
  const filtered = filter !== 'all' || !!q;

  return (
    <Page title="My Work">
      <div className="mx-auto max-w-5xl space-y-4">
        <ProjectFilterNote />
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative min-w-0 max-w-sm flex-1 basis-56">
            <label htmlFor="work-search" className="sr-only">
              Search my work
            </label>
            <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-zinc-400" aria-hidden />
            <Input id="work-search" type="search" className="pl-8" placeholder="Search my work" value={search} onChange={(event) => setSearch(event.target.value)} />
          </div>
          <div role="group" aria-label="Filter by status" className="flex flex-wrap items-center gap-2">
            {WORK_FILTERS.map((f) => (
              <button
                key={f.id}
                type="button"
                aria-pressed={filter === f.id}
                onClick={() => setParam('status', f.id === 'all' ? '' : f.id)}
                className={cx(
                  'rounded-full px-3 py-1 text-sm font-medium ring-1 ring-inset focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500',
                  filter === f.id
                    ? 'bg-accent-600 text-white ring-accent-600 dark:bg-accent-500 dark:ring-accent-500'
                    : 'bg-white text-zinc-700 ring-zinc-300 hover:bg-zinc-50 dark:bg-zinc-900 dark:text-zinc-300 dark:ring-zinc-700 dark:hover:bg-zinc-800',
                )}
              >
                {f.label}
              </button>
            ))}
            {runs.isFetching && !runs.isPending && <Spinner label="Refreshing" />}
          </div>
        </div>

        {runs.isPending ? (
          <LoadingState label="Loading your work…" />
        ) : runs.isError ? (
          <ErrorState error={runs.error} title="Your work could not be loaded." onRetry={() => void runs.refetch()} />
        ) : items.length === 0 ? (
          <div className="rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
            {filtered ? (
              <EmptyState
                icon={<Search className="h-5 w-5" aria-hidden />}
                title="No task matches"
                action={
                  <Button
                    onClick={() => {
                      setSearch('');
                      setParams(
                        (current) => {
                          const next = new URLSearchParams(current);
                          next.delete('q');
                          next.delete('status');
                          return next;
                        },
                        { replace: true },
                      );
                    }}
                  >
                    Clear the search and filters
                  </Button>
                }
              />
            ) : (
              <EmptyState
                icon={<ClipboardList className="h-5 w-5" aria-hidden />}
                title={projectId ? `Nothing yet in ${projectLabel(projectId, names)}` : 'Nothing yet'}
                action={
                  <ButtonLink to={homeLink({ project: projectId })} variant="primary">
                    Start on Home
                  </ButtonLink>
                }
              />
            )}
          </div>
        ) : (
          <>
            <p className="text-xs text-zinc-500 dark:text-zinc-400" aria-live="polite">
              {runs.data.total === 1 ? '1 task' : `${runs.data.total} tasks`}
              {items.length < runs.data.total && `, showing the newest ${items.length}`}
            </p>
            <ul className="divide-y divide-zinc-100 overflow-hidden rounded-lg border border-zinc-200 bg-white dark:divide-zinc-800 dark:border-zinc-800 dark:bg-zinc-900">
              {items.map((run) => (
                <TaskItem
                  key={run.id}
                  run={run}
                  agents={agents.data?.items}
                  now={now}
                  projectName={projectId ? null : run.project_id ? projectLabel(run.project_id, names) : null}
                  actions={<TaskActions run={run} onDelete={() => setToDelete(run)} />}
                />
              ))}
            </ul>
            {items.length < runs.data.total && (
              <div className="flex justify-center">
                <Button onClick={() => setPages((n) => n + 1)} loading={runs.isFetching}>
                  Show more
                </Button>
              </div>
            )}
          </>
        )}
      </div>
      <DeleteTask run={toDelete} onClose={() => setToDelete(null)} />
    </Page>
  );
}

function TaskActions({ run, onDelete }: { run: RunSummary; onDelete: () => void }) {
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
  const text = plainTaskText(run.task);
  return (
    <>
      {run.status === 'interrupted' && (
        <Button size="xs" variant="primary" icon={<Play className="h-3.5 w-3.5" />} loading={resume.isPending} onClick={() => resume.mutate()}>
          Continue
        </Button>
      )}
      {(run.status === 'failed' || run.status === 'cancelled') && text && (
        <ButtonLink
          size="xs"
          to={homeLink({ task: text, project: run.project_id, agent: run.kind === 'agent' ? run.agent_id : null })}
          icon={<RotateCcw className="h-3.5 w-3.5" aria-hidden />}
        >
          Start again
        </ButtonLink>
      )}
      {!isActive(run.status) && (
        <IconButton label={`Delete the task “${text.slice(0, 60)}”`} onClick={onDelete} className="h-7 w-7">
          <Trash2 className="h-3.5 w-3.5" />
        </IconButton>
      )}
    </>
  );
}

function DeleteTask({ run, onClose }: { run: RunSummary | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const { notify } = useToast();
  const remove = useMutation({
    mutationFn: (id: string) => deleteRun(id),
    onSuccess: () => {
      notify('Task deleted.');
      void queryClient.invalidateQueries({ queryKey: qk.runs });
      onClose();
    },
  });
  return (
    <ConfirmDialog
      open={!!run}
      title="Delete this task?"
      confirmLabel="Delete permanently"
      danger
      loading={remove.isPending}
      onConfirm={() => run && remove.mutate(run.id)}
      onCancel={() => {
        remove.reset();
        onClose();
      }}
    >
      <p className="break-words">“{plainTaskText(run?.task).slice(0, 200)}”</p>
      <p className="mt-2">Its result, steps and approvals are removed. This cannot be undone. Files in the project folder are kept.</p>
      {remove.isError && <p className="mt-2 text-red-700 dark:text-red-400">Not deleted: {(remove.error as Error).message}</p>}
    </ConfirmDialog>
  );
}
