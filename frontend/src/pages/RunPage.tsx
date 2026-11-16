// Technical details of a run (and its tree of delegated / team member runs): every event as recorded,
// for troubleshooting. The plain view of the same task is the Live Workspace (/workspace/:id).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, FlaskConical, ListTree, Radio, RotateCcw, ShieldQuestion, Trash2, WifiOff, Workflow } from 'lucide-react';
import { cancelRun, deleteRun, getRun, resumeRun } from '../api/endpoints';
import { qk } from '../api/keys';
import type { RunDetailResponse, RunEvent } from '../api/types';
import { Page } from '../components/Page';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  ConfirmDialog,
  Disclosure,
  Drawer,
  ErrorState,
  JsonBlock,
  KeyValue,
  LoadingState,
  Mono,
  StatusBadge,
  TD,
  TH,
  Table,
  Tabs,
} from '../components/ui';
import { ButtonLink, CopyButton } from '../components/ui';
import { projectLabel, useProjectNames } from '../features/projects/ProjectContext';
import { ErrorPanel, ResultPanel, RunTreePanel, runTitle } from '../features/runs/RunPanels';
import { SourceChip, SourceLegend, Timeline, TimelineGroups, TimelineProvider } from '../features/runs/Timeline';
import { buildTreeSections } from '../features/runs/timelineModel';
import { useRunEvents, type ConnectionState } from '../features/runs/useRunEvents';
import { errorMessage } from '../api/client';
import { cx } from '../lib/cx';
import { elapsedSeconds, formatCost, formatDateTime, formatDuration, formatTime, formatTokens, shortId } from '../lib/format';
import { useNow } from '../lib/hooks';
import { isActive, providerLabel } from '../lib/status';

type ViewMode = 'run' | 'tree' | 'raw';

const RUN_END_EVENTS = new Set(['run.completed', 'run.failed', 'run.cancelled', 'run.interrupted']);

export function RunPage() {
  const { runId = '' } = useParams();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const detail = useQuery({ queryKey: qk.run(runId), queryFn: () => getRun(runId), enabled: !!runId });
  const data = detail.data;
  const run = data?.run;
  const rootSummary = data?.tree.find((r) => r.id === run?.root_run_id);
  const rootStatus = rootSummary?.status ?? run?.status;
  const live = isActive(rootStatus);

  // Refresh the run detail (status, counters, approvals) while events arrive, at most every 500 ms.
  const refreshTimer = useRef<number | null>(null);
  const onEvents = useCallback(
    (batch: RunEvent[]) => {
      if (batch.some((e) => e.type.startsWith('approval.'))) {
        void queryClient.invalidateQueries({ queryKey: qk.approvals });
      }
      if (batch.some((e) => RUN_END_EVENTS.has(e.type))) {
        void queryClient.invalidateQueries({ queryKey: [...qk.runs, 'list'] });
        void queryClient.invalidateQueries({ queryKey: qk.dashboard });
      }
      if (refreshTimer.current !== null) return;
      refreshTimer.current = window.setTimeout(() => {
        refreshTimer.current = null;
        void queryClient.invalidateQueries({ queryKey: qk.run(runId) });
      }, 500);
    },
    [queryClient, runId],
  );
  useEffect(
    () => () => {
      if (refreshTimer.current !== null) window.clearTimeout(refreshTimer.current);
    },
    [],
  );

  const stream = useRunEvents(run?.root_run_id, live, onEvents);
  const [mode, setMode] = useState<ViewMode | null>(null);
  const viewMode: ViewMode = mode ?? (run?.kind === 'team' ? 'tree' : 'run');
  const [inspected, setInspected] = useState<RunEvent | null>(null);
  const [confirm, setConfirm] = useState<'cancel' | 'delete' | null>(null);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: qk.run(runId) });
    void queryClient.invalidateQueries({ queryKey: [...qk.runs, 'list'] });
  };
  const cancel = useMutation({ mutationFn: () => cancelRun(runId), onSuccess: invalidate, onSettled: () => setConfirm(null) });
  const resume = useMutation({ mutationFn: () => resumeRun(run?.root_run_id ?? runId), onSuccess: invalidate });
  const remove = useMutation({
    mutationFn: () => deleteRun(runId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.runs });
      void queryClient.invalidateQueries({ queryKey: qk.dashboard });
      navigate('/work');
    },
    onSettled: () => setConfirm(null),
  });

  const runEvents = useMemo(() => stream.events.filter((e) => e.run_id === runId), [stream.events, runId]);
  const sections = useMemo(() => (data ? buildTreeSections(stream.events, data.tree) : []), [stream.events, data]);
  const failureCode = useMemo(() => {
    const failed = [...runEvents].reverse().find((e) => e.type === 'run.failed');
    return typeof failed?.data.code === 'string' ? failed.data.code : undefined;
  }, [runEvents]);

  if (detail.isPending) {
    return (
      <Page title="Technical details" back={{ to: `/workspace/${runId}`, label: 'Back to the task' }}>
        <LoadingState label="Loading…" />
      </Page>
    );
  }
  if (detail.isError || !data || !run) {
    return (
      <Page title="Technical details" back={{ to: '/workspace', label: 'Live Workspace' }}>
        <ErrorState error={detail.error} title="Cannot load this run" onRetry={() => void detail.refetch()} />
      </Page>
    );
  }

  const isRoot = !run.parent_run_id;
  const canResume = isRoot && (run.status === 'interrupted' || run.status === 'failed');
  const canCancel = isActive(run.status);
  const canDelete = isRoot && !isActive(run.status);
  const pendingApprovals = data.approvals.filter((a) => a.status === 'pending');
  const hasResult = run.status === 'completed' || run.output !== null || !!run.output_text;

  return (
    <Page
      wide
      title={
        <span className="flex flex-wrap items-center gap-2">
          Technical details
          <StatusBadge status={run.status} />
        </span>
      }
      description={
        <>
          For troubleshooting: every event as recorded.{' '}
          <Link to={`/workspace/${run.id}`} className="font-medium text-accent-700 hover:underline dark:text-accent-300">
            Follow this task in plain words
          </Link>
        </>
      }
      documentTitle={`Technical details ${shortId(run.id)}`}
      back={{ to: `/workspace/${run.id}`, label: 'Back to the task' }}
      actions={
        <>
          {!isRoot && (
            <ButtonLink to={`/runs/${run.root_run_id}`} icon={<Workflow className="h-4 w-4" />}>
              Whole task
            </ButtonLink>
          )}
          {canResume && (
            <Button
              variant="primary"
              icon={<RotateCcw className="h-4 w-4" />}
              loading={resume.isPending}
              onClick={() => resume.mutate()}
            >
              Resume
            </Button>
          )}
          {canCancel && (
            <Button variant="danger" icon={<Ban className="h-4 w-4" />} onClick={() => setConfirm('cancel')}>
              Cancel
            </Button>
          )}
          {canDelete && (
            <Button variant="ghost" icon={<Trash2 className="h-4 w-4" />} onClick={() => setConfirm('delete')}>
              Delete
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-4">
        {run.scripted && (
          <Alert tone="amber" icon={<FlaskConical className="h-4 w-4" />} title="Scripted test run — no model involved">
            Tools, permissions, approvals and limits are real; the messages come from a script.
          </Alert>
        )}
        {(cancel.isError || resume.isError || remove.isError) && (
          <ErrorState compact error={cancel.error ?? resume.error ?? remove.error} title="Action failed" />
        )}
        {pendingApprovals.length > 0 && (
          <Alert tone="amber" icon={<ShieldQuestion className="h-4 w-4" />} title={`${pendingApprovals.length} approval${pendingApprovals.length > 1 ? 's' : ''} waiting for you`}>
            In the timeline below{pendingApprovals.some((a) => a.run_id !== run.id) && ' (“Whole tree” for other runs)'}, or in{' '}
            <Link to="/approvals" className="font-medium underline">
              Approvals
            </Link>
            .
          </Alert>
        )}

        <RunHeader data={data} connection={stream.connection} live={live} />

        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
          <div className="min-w-0 space-y-4">
            <ErrorPanel run={run} code={failureCode} />
            {hasResult && <ResultPanel run={run} />}

            <Card>
              <CardHeader
                title="Execution timeline"
                description="Events recorded by the platform."
                actions={<ConnectionBadge state={stream.connection} live={live} onReconnect={stream.reconnect} />}
              />
              <div className="space-y-3 px-4 pt-3">
                <SourceLegend />
                <Tabs<ViewMode>
                  label="Timeline view"
                  value={viewMode}
                  onChange={setMode}
                  tabs={[
                    { id: 'run', label: 'This run', count: runEvents.length },
                    { id: 'tree', label: 'Whole tree', count: stream.events.length },
                    { id: 'raw', label: 'Raw events' },
                  ]}
                />
              </div>
              <CardBody>
                {stream.error ? <ErrorState compact error={stream.error} title="Events could not be loaded" onRetry={stream.reconnect} /> : null}
                <TimelineProvider approvals={data.approvals} onInspect={setInspected} currentRunId={run.id}>
                  {viewMode === 'run' && <Timeline events={runEvents} />}
                  {viewMode === 'tree' && (
                    <div className="space-y-6">
                      {sections.map((section) => (
                        <section key={section.runId} aria-label={`Run ${section.runId}`} style={{ marginLeft: `${Math.min(section.depth, 4) * 0.75}rem` }}>
                          <div className="mb-2 flex flex-wrap items-center gap-2 rounded-md bg-zinc-50 px-3 py-2 dark:bg-zinc-950/60">
                            <ListTree className="h-4 w-4 text-zinc-400" aria-hidden />
                            <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                              {section.run ? runTitle(section.run) : 'Run'}
                            </span>
                            {section.run && <StatusBadge status={section.run.status} />}
                            {section.run?.role && <span className="text-xs text-zinc-500">{section.run.role}</span>}
                            <Link to={`/runs/${section.runId}`} className="ml-auto text-xs font-medium text-accent-700 hover:underline dark:text-accent-300">
                              <Mono className="text-xs">{section.runId.slice(0, 8)}</Mono>
                            </Link>
                          </div>
                          {section.eventCount > 0 ? (
                            <TimelineGroups groups={section.groups} />
                          ) : (
                            <p className="pl-3 text-xs text-zinc-400">No events yet.</p>
                          )}
                        </section>
                      ))}
                    </div>
                  )}
                  {viewMode === 'raw' && <RawEvents events={stream.events} onInspect={setInspected} />}
                </TimelineProvider>
              </CardBody>
            </Card>
          </div>

          <aside className="min-w-0 space-y-4">
            {(data.tree.length > 1 || run.kind === 'team') && <RunTreePanel tree={data.tree} currentId={run.id} />}
            <RunDetailsCard data={data} />
          </aside>
        </div>
      </div>

      <Drawer open={!!inspected} onClose={() => setInspected(null)} title={inspected ? `Event #${inspected.id} · ${inspected.type}` : ''}>
        {inspected && (
          <div className="space-y-3">
            <KeyValue
              items={[
                { label: 'Source', value: <SourceChip source={inspected.source} /> },
                { label: 'Type', value: <Mono>{inspected.type}</Mono> },
                { label: 'Run', value: <Mono>{inspected.run_id}</Mono> },
                { label: 'Sequence', value: <Mono>{inspected.seq}</Mono> },
                { label: 'Time', value: formatDateTime(inspected.ts) },
              ]}
            />
            <div className="flex justify-end">
              <CopyButton text={JSON.stringify(inspected, null, 2)} label="Copy JSON" />
            </div>
            <JsonBlock value={inspected} maxHeight="max-h-[70vh]" />
          </div>
        )}
      </Drawer>

      <ConfirmDialog
        open={confirm === 'cancel'}
        title="Cancel this run?"
        confirmLabel="Cancel run"
        danger
        loading={cancel.isPending}
        onConfirm={() => cancel.mutate()}
        onCancel={() => setConfirm(null)}
      >
        The run stops at its next checkpoint. Child runs it delegated to are cancelled too.
      </ConfirmDialog>
      <ConfirmDialog
        open={confirm === 'delete'}
        title="Delete this run?"
        confirmLabel="Delete permanently"
        danger
        loading={remove.isPending}
        onConfirm={() => remove.mutate()}
        onCancel={() => setConfirm(null)}
      >
        The run, all runs of its tree, their events and approvals are removed from the database. This cannot be undone.
        {remove.isError && <p className="mt-2 text-red-600">{errorMessage(remove.error)}</p>}
      </ConfirmDialog>
    </Page>
  );
}

function RunHeader({ data, connection, live }: { data: RunDetailResponse; connection: ConnectionState; live: boolean }) {
  const { run, tree_totals: totals, tree } = data;
  const names = useProjectNames();
  const now = useNow(1000, isActive(run.status));
  const elapsed = elapsedSeconds(run, now);
  const treeWide = tree.length > 1;
  const stats: { label: string; value: string; hint?: string }[] = [
    { label: 'Elapsed', value: formatDuration(elapsed) },
    { label: 'Steps', value: String(treeWide ? (totals.steps ?? run.steps) : run.steps), hint: treeWide ? 'whole tree' : undefined },
    { label: 'Tool calls', value: String(treeWide ? totals.tool_calls : run.tool_calls), hint: treeWide ? 'whole tree' : undefined },
    {
      label: 'Tokens',
      value: `${formatTokens(treeWide ? totals.input_tokens : run.input_tokens)} / ${formatTokens(treeWide ? totals.output_tokens : run.output_tokens)}`,
      hint: `in / out${treeWide ? ' · whole tree' : ''}`,
    },
    {
      label: 'Usage est.',
      value: formatCost(treeWide ? totals.cost_usd : run.cost_usd),
      hint: `API-equivalent, not billed${treeWide ? ' · whole tree' : ''}`,
    },
  ];
  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-4 p-4">
        <div className="min-w-0 space-y-1">
          <p className="line-clamp-3 whitespace-pre-wrap text-sm text-zinc-800 dark:text-zinc-200">{run.task}</p>
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-500 dark:text-zinc-400">
            <span>
              {run.kind === 'team' ? 'Team' : 'Agent'}{' '}
              {run.kind === 'agent' && run.agent_id ? (
                <Link to={`/team/${run.agent_id}`} className="font-mono text-zinc-700 hover:underline dark:text-zinc-300">
                  {run.agent_id}
                </Link>
              ) : (
                <span className="font-medium text-zinc-700 dark:text-zinc-300">{runTitle(run)}</span>
              )}
              {run.agent_version && <Mono className="ml-1 text-[0.7rem]">v{run.agent_version}</Mono>}
            </span>
            <span>
              Provider <span className="font-medium text-zinc-700 dark:text-zinc-300">{run.provider ? providerLabel(run.provider) : 'per agent'}</span>
              {run.model && run.model !== 'scripted' && <Mono className="ml-1 text-zinc-700 dark:text-zinc-300">{run.model}</Mono>}
            </span>
            <span>
              <Mono className="text-zinc-600 dark:text-zinc-400">{run.id}</Mono>
            </span>
            {run.role && <span>Role: {run.role}</span>}
            {run.resumes > 0 && <Badge tone="slate">resumed {run.resumes}×</Badge>}
            {run.paused && <Badge tone="amber">paused: no new task starts</Badge>}
            {run.project_id && (
              <Link to={`/projects/${run.project_id}`} className="font-medium text-accent-700 hover:underline dark:text-accent-300">
                Project {projectLabel(run.project_id, names)}
              </Link>
            )}
            {live && connection !== 'open' && connection !== 'idle' && <Badge tone="amber">{connection}</Badge>}
          </p>
        </div>
      </div>
      <dl className="grid grid-cols-2 border-t border-zinc-200 dark:border-zinc-800 sm:grid-cols-3 lg:grid-cols-5">
        {stats.map((stat) => (
          <div key={stat.label} className="border-b border-r border-zinc-100 px-4 py-3 dark:border-zinc-800">
            <dt className="text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">{stat.label}</dt>
            <dd className="mt-0.5 text-base font-semibold tabular-nums text-zinc-900 dark:text-zinc-50">{stat.value}</dd>
            {stat.hint && <dd className="text-xs text-zinc-400">{stat.hint}</dd>}
          </div>
        ))}
      </dl>
    </Card>
  );
}

function ConnectionBadge({ state, live, onReconnect }: { state: ConnectionState; live: boolean; onReconnect: () => void }) {
  if (!live) {
    return (
      <span className="text-xs text-zinc-500 dark:text-zinc-400">{state === 'loading' ? 'Loading events…' : 'Run finished · history'}</span>
    );
  }
  if (state === 'open') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-blue-700 dark:text-blue-300">
        <Radio className="h-3.5 w-3.5" aria-hidden /> Live
      </span>
    );
  }
  if (state === 'closed' || state === 'unsupported') {
    return (
      <span className="inline-flex items-center gap-2">
        <span className="inline-flex items-center gap-1 text-xs text-red-600 dark:text-red-400">
          <WifiOff className="h-3.5 w-3.5" aria-hidden /> Live connection closed
        </span>
        <Button size="xs" onClick={onReconnect}>
          Reconnect
        </Button>
      </span>
    );
  }
  return <span className="text-xs text-amber-700 dark:text-amber-300">{state === 'reconnecting' ? 'Reconnecting…' : 'Connecting…'}</span>;
}

function RawEvents({ events, onInspect }: { events: RunEvent[]; onInspect: (event: RunEvent) => void }) {
  if (events.length === 0) return <p className="py-6 text-center text-sm text-zinc-500">No events yet.</p>;
  return (
    <Table>
      <thead>
        <tr>
          <th className={TH}>#</th>
          <th className={TH}>Time</th>
          <th className={TH}>Run</th>
          <th className={TH}>Source</th>
          <th className={TH}>Type</th>
          <th className={TH}>
            <span className="sr-only">Inspect</span>
          </th>
        </tr>
      </thead>
      <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
        {events.map((event) => (
          <tr key={event.id}>
            <td className={cx(TD, 'font-mono text-xs tabular-nums')}>{event.id}</td>
            <td className={cx(TD, 'whitespace-nowrap text-xs tabular-nums')}>{formatTime(event.ts)}</td>
            <td className={cx(TD, 'font-mono text-xs')}>{event.run_id.slice(0, 8)}</td>
            <td className={TD}>
              <SourceChip source={event.source} />
            </td>
            <td className={cx(TD, 'font-mono text-xs')}>{event.type}</td>
            <td className={TD}>
              <Button size="xs" variant="ghost" onClick={() => onInspect(event)}>
                JSON
              </Button>
            </td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

function RunDetailsCard({ data }: { data: RunDetailResponse }) {
  const { run } = data;
  return (
    <Card>
      <CardHeader title="Details" />
      <CardBody className="space-y-3">
        <KeyValue
          items={[
            { label: 'Created', value: formatDateTime(run.created_at) },
            { label: 'Started', value: formatDateTime(run.started_at) },
            { label: 'Finished', value: formatDateTime(run.finished_at) },
            { label: 'Workspace', value: <Mono className="break-all">{run.workspace ?? '—'}</Mono> },
            ...(run.team ? [{ label: 'Team mode', value: run.team.mode }] : []),
          ]}
        />
        <Disclosure summary="Full task">
          <p className="whitespace-pre-wrap text-sm text-zinc-800 dark:text-zinc-200">{run.task}</p>
        </Disclosure>
        {run.input && (
          <Disclosure summary="Input">
            <JsonBlock value={run.input} />
          </Disclosure>
        )}
        {run.limits && (
          <Disclosure summary="Effective limits">
            <JsonBlock value={run.limits} />
          </Disclosure>
        )}
        {run.team && (
          <Disclosure summary="Team specification">
            <JsonBlock value={run.team} />
          </Disclosure>
        )}
      </CardBody>
    </Card>
  );
}
