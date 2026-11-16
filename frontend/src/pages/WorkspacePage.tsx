// Live Workspace: follow any task (one team member or a whole team) while it is worked on.
// Without a task: the tasks in progress and recently finished. With one (/workspace/:runId):
// the request and where it stands, approvals waiting for the owner, the steps in plain words
// with what each team member received and delivered, the final result, and a chronological
// activity feed. The detailed map (graph canvas + inspector) stays available as an advanced view.
// Everything comes from GET /api/runs/{root}/graph, the run detail and the task's real events;
// the graph is refetched when the live stream reports a structural event.

import { forwardRef, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ListChecks, Shield, ShieldAlert, ShieldCheck, ShieldQuestion } from 'lucide-react';
import { getRun, getRunGraph, listAgents } from '../api/endpoints';
import { qk } from '../api/keys';
import type { ApprovalGraphNode, ExecutionGraph, JsonValue, RunDetailResponse, RunEvent, SecurityReviewState, TaskGraphNode } from '../api/types';
import { Page } from '../components/Page';
import { ErrorState, LoadingState, useHelp } from '../components/ui';
import { useToast } from '../components/toast';
import { ApprovalCard, type ApprovalView } from '../features/approvals/ApprovalCard';
import { projectLabel, useProjectNames, useProjectSelection } from '../features/projects/ProjectContext';
import { useRunEvents } from '../features/runs/useRunEvents';
import { ActivityFeed } from '../features/workspace/ActivityFeed';
import type { ActivityContext } from '../features/workspace/activity';
import { ContinueBox, FinalResult, TaskEnded, blockedReview, finalOf } from '../features/workspace/FinalResult';
import { NodeInspector } from '../features/workspace/NodeInspector';
import { OrchestrationCanvas } from '../features/workspace/OrchestrationCanvas';
import { StepsView, stepAnchor } from '../features/workspace/StepsView';
import { TaskHeader, type WorkspaceView } from '../features/workspace/TaskHeader';
import { TaskLanding } from '../features/workspace/TaskLanding';
import { buildSteps, finalOutputs, involvedMembers, mergeNames, planTitles, stepOfRun, type Names, type StepsModel } from '../features/workspace/steps';
import { COORDINATOR_ID, isPlanTool, memberName, plainTaskText, verdictOf } from '../lib/plain';
import { cx } from '../lib/cx';
import { isActive, isTerminal } from '../lib/status';

/** Events after which the graph is refetched (debounced). */
export function changesGraph(type: string): boolean {
  return (
    type.startsWith('plan.') ||
    type.startsWith('task.') ||
    type === 'handoff' ||
    type.startsWith('approval.') ||
    type.startsWith('run.') ||
    type.startsWith('delegation.') ||
    type.startsWith('team.')
  );
}

/** Events that only move usage counters: refreshed less eagerly. */
const USAGE_EVENTS = new Set(['model.response', 'tool.completed', 'tool.failed']);

export const GRAPH_DEBOUNCE_MS = 300;
const GRAPH_MAX_WAIT_MS = 1000;
const USAGE_REFRESH_MS = 1500;

/** The chosen view, remembered per browser. */
export const VIEW_STORAGE_KEY = 'pae.workspace.view';

function initialView(): WorkspaceView {
  try {
    if (window.localStorage.getItem(VIEW_STORAGE_KEY) !== 'map') return 'steps';
    // Small screens show the steps first, whatever was chosen on a large one.
    return typeof window.matchMedia !== 'function' || window.matchMedia('(min-width: 1024px)').matches ? 'map' : 'steps';
  } catch {
    return 'steps';
  }
}

function storeView(view: WorkspaceView): void {
  try {
    window.localStorage.setItem(VIEW_STORAGE_KEY, view);
  } catch {
    // Storage unavailable: the choice lasts for this page only.
  }
}

export function WorkspacePage() {
  const { runId } = useParams();
  const { projectId } = useProjectSelection();
  return (
    <Page
      wide
      title="Live Workspace"
      description={runId ? undefined : 'Follow your AI team as it works.'}
      back={runId ? { to: '/workspace', label: 'All tasks' } : undefined}
      help={<WorkspaceHelp />}
    >
      {runId ? <TaskView key={runId} runId={runId} /> : <TaskLanding projectId={projectId} />}
    </Page>
  );
}

function WorkspaceHelp() {
  return (
    <p>
      The Coordinator splits a task into steps, each done by the right team member. Everything here is what the platform recorded: nothing moves
      when nothing happens.
    </p>
  );
}

// ------------------------------------------------------------------ one task

function activityContextOf(graph: ExecutionGraph, run: RunDetailResponse | undefined, names: Names): ActivityContext {
  const root = graph.nodes.find((n) => n.kind === 'root');
  const runAgents: Record<string, string | null> = {};
  for (const r of run?.tree ?? []) runAgents[r.id] = r.agent_id;
  const tasks: Record<string, { title: string; agentId: string }> = {};
  for (const node of graph.nodes) {
    if (node.kind !== 'task') continue;
    tasks[`${node.plan_id}:${node.task_id}`] = { title: node.title, agentId: node.agent_id };
    for (const id of node.run_ids) runAgents[id] = node.agent_id;
  }
  return { rootRunId: graph.root_run_id, names, rootAgentId: root && root.kind === 'root' ? root.agent_id : null, runAgents, tasks };
}

function TaskView({ runId }: { runId: string }) {
  const queryClient = useQueryClient();
  const { notify } = useToast();
  const projectNames = useProjectNames();
  const graphQuery = useQuery({ queryKey: qk.executionGraph(runId), queryFn: () => getRunGraph(runId) });
  const graph = graphQuery.data;
  const rootId = graph?.root_run_id ?? runId;
  const live = !!graph && isActive(graph.status);
  const runQuery = useQuery({
    queryKey: qk.run(rootId),
    queryFn: () => getRun(rootId),
    enabled: !!graph,
    // The security review of a change is a task of its own: look again until it has decided.
    refetchInterval: (query) => (reviewPending(query.state.data?.security_review) ? REVIEW_REFRESH_MS : false),
  });
  const agents = useQuery({ queryKey: qk.agents, queryFn: listAgents, staleTime: 60_000 });

  // ---------------------------------------------------------------- live refresh (debounced)
  const timer = useRef<number | null>(null);
  const firstAt = useRef<number | null>(null);
  const refresh = useCallback(() => {
    timer.current = null;
    firstAt.current = null;
    void queryClient.invalidateQueries({ queryKey: qk.executionGraph(runId) });
    void queryClient.invalidateQueries({ queryKey: qk.run(rootId) });
  }, [queryClient, runId, rootId]);
  const schedule = useCallback(
    (structural: boolean) => {
      const now = Date.now();
      if (!structural) {
        if (timer.current === null) timer.current = window.setTimeout(refresh, USAGE_REFRESH_MS);
        return;
      }
      if (firstAt.current === null) firstAt.current = now;
      const delay = Math.max(0, Math.min(GRAPH_DEBOUNCE_MS, firstAt.current + GRAPH_MAX_WAIT_MS - now));
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(refresh, delay);
    },
    [refresh],
  );
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );
  const onEvents = useCallback(
    (batch: RunEvent[]) => {
      if (batch.some((e) => changesGraph(e.type))) schedule(true);
      else if (batch.some((e) => USAGE_EVENTS.has(e.type))) schedule(false);
      if (batch.some((e) => e.type.startsWith('approval.'))) void queryClient.invalidateQueries({ queryKey: qk.approvals });
      if (batch.some((e) => e.type === 'run.completed' || e.type === 'run.failed' || e.type === 'run.cancelled' || e.type === 'run.interrupted')) {
        void queryClient.invalidateQueries({ queryKey: qk.executions });
        void queryClient.invalidateQueries({ queryKey: [...qk.runs, 'list'] });
        void queryClient.invalidateQueries({ queryKey: qk.dashboard });
      }
    },
    [schedule, queryClient],
  );
  const stream = useRunEvents(graph ? rootId : undefined, live, onEvents);

  // ---------------------------------------------------------------- derived, plain models
  const names = useMemo(() => mergeNames(graph, agents.data?.items), [graph, agents.data]);
  const model = useMemo(() => (graph ? buildSteps(graph, { names, events: stream.events }) : null), [graph, names, stream.events]);
  const finals = useMemo(() => finalOutputs(stream.events), [stream.events]);
  const activityContext = useMemo(() => (graph ? activityContextOf(graph, runQuery.data, names) : null), [graph, runQuery.data, names]);
  const titlesOf = useCallback((planId: string) => (graph ? planTitles(graph, planId) : new Map<string, string>()), [graph]);

  // ---------------------------------------------------------------- view and selection
  const [view, setView] = useState<WorkspaceView>(initialView);
  const changeView = (next: WorkspaceView) => {
    setView(next);
    storeView(next);
  };
  const [selected, setSelected] = useState<string | null>(null);
  const approvalsRef = useRef<HTMLElement>(null);
  // A step's run id in the address opens that step.
  const preselected = useRef(false);
  useEffect(() => {
    if (!graph || preselected.current) return;
    preselected.current = true;
    if (runId === graph.root_run_id) return;
    const task = graph.nodes.find((n): n is TaskGraphNode => n.kind === 'task' && n.run_ids.includes(runId));
    if (!task) return;
    setSelected(task.id);
    window.setTimeout(() => {
      const element = document.getElementById(stepAnchor(task.id));
      element?.scrollIntoView?.({ block: 'center' });
      element?.focus({ preventScroll: true });
    }, 0);
  }, [graph, runId]);

  if (graphQuery.isPending) return <LoadingState label="Loading this task…" />;
  if (graphQuery.isError || !graph || !model || !activityContext) {
    return <ErrorState error={graphQuery.error} title="This task could not be loaded" onRetry={() => void graphQuery.refetch()} />;
  }

  const run = runQuery.data;
  const showApprovals = () => {
    const target = approvalsRef.current ?? document.getElementById(PLAN_ANCHOR);
    target?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
    target?.focus({ preventScroll: true });
  };
  const onDecided = () => {
    void queryClient.invalidateQueries({ queryKey: qk.executionGraph(runId) });
    void queryClient.invalidateQueries({ queryKey: qk.run(rootId) });
    notify('Decision recorded');
  };

  return (
    <div className="space-y-4">
      <TaskHeader
        rootRunId={rootId}
        request={plainTaskText(run ? run.run.task : graph.title)}
        status={graph.status}
        paused={graph.paused}
        projectName={graph.project_id ? projectLabel(graph.project_id, projectNames) : null}
        scripted={!!run?.run.scripted}
        counts={model.counts}
        members={involvedMembers(model)}
        live={live}
        connection={stream.connection}
        onReconnect={stream.reconnect}
        view={view}
        onViewChange={changeView}
        outcome={graph.status === 'completed' && run ? finalOf(run.run).report.outcome : null}
        verdict={graph.status === 'completed' && run ? verdictOf(run.run.output) : null}
        followUpOf={run?.run.follow_up_of ?? null}
        onPausedChange={(paused) => {
          queryClient.setQueryData<ExecutionGraph>(qk.executionGraph(runId), (current) => (current ? { ...current, paused } : current));
          void queryClient.invalidateQueries({ queryKey: qk.executionGraph(runId) });
          void queryClient.invalidateQueries({ queryKey: qk.run(rootId) });
          void queryClient.invalidateQueries({ queryKey: qk.executions });
          notify(paused ? 'Paused: no new step will start.' : 'Resumed: the next steps can start.');
        }}
      />

      <PlanArea graph={graph} run={run} model={model} names={names} onDecided={onDecided} />
      <ApprovalsArea ref={approvalsRef} graph={graph} run={run} model={model} names={names} onDecided={onDecided} />

      {view === 'steps' ? (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_24rem] xl:items-start">
          <div className="min-w-0 space-y-4">
            {isTerminal(graph.status) &&
              (run ? (
                <>
                  {graph.status === 'completed' ? (
                    <>
                      <FinalResult run={run.run} names={names} />
                      {run.security_review && <ReviewNote review={run.security_review} names={names} />}
                    </>
                  ) : (
                    <TaskEnded run={run.run} names={names} projectId={graph.project_id} />
                  )}
                  {/* An interrupted task continues where it stopped instead (its own "Continue"). */}
                  {graph.status !== 'interrupted' && <ContinueBox runId={rootId} fixBlock={graph.status === 'completed' && blockedReview(run.run)} />}
                </>
              ) : runQuery.isError ? (
                <ErrorState compact error={runQuery.error} title="The result could not be loaded" onRetry={() => void runQuery.refetch()} />
              ) : (
                <LoadingState label="Loading the result…" />
              ))}
            <StepsView model={model} paused={graph.paused} taskStatus={graph.status} finals={finals} names={names} titlesOf={titlesOf} onShowApprovals={showApprovals} />
          </div>
          <ActivityFeed
            events={stream.events}
            context={activityContext}
            loading={stream.connection === 'loading' || stream.connection === 'connecting'}
            error={stream.error}
            onRetry={stream.reconnect}
          />
        </div>
      ) : (
        <MapView graph={graph} run={run} events={stream.events} selected={selected} onSelectedChange={setSelected} agentNames={names} onDecided={onDecided} />
      )}
    </div>
  );
}

// ------------------------------------------------------------------ the security review of this task's change

const REVIEW_REFRESH_MS = 3000;

/** True while the review has not decided yet (about to start, or at work). */
export function reviewPending(review: SecurityReviewState | null | undefined): boolean {
  return !!review && (review.status === 'starting' || isActive(review.status));
}

/** Under the result of a code change: where its security review stands, and the way to it. */
function ReviewNote({ review, names }: { review: SecurityReviewState; names: Names }) {
  const who = memberName('security', names);
  const pending = reviewPending(review);
  const blocks = review.status === 'completed' && review.verdict === 'block';
  const text = pending
    ? `${who} is reviewing this change…`
    : blocks
      ? `${who} blocked this change.`
      : review.status === 'completed' && review.verdict === 'pass_with_warnings'
        ? `${who} passed this change, with warnings.`
        : review.status === 'completed' && review.verdict === 'pass'
          ? `${who} reviewed this change: nothing blocks.`
          : 'The security review of this change did not finish.';
  const Icon = blocks ? ShieldAlert : pending ? Shield : review.verdict ? ShieldCheck : ShieldQuestion;
  return (
    <p
      role="status"
      className={cx(
        'flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border px-3 py-2 text-sm',
        blocks
          ? 'border-red-300 bg-red-50 text-red-900 dark:border-red-900 dark:bg-red-950/40 dark:text-red-100'
          : 'border-zinc-200 bg-white text-zinc-800 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200',
      )}
    >
      <Icon className={cx('h-4 w-4 shrink-0', blocks ? 'text-red-600 dark:text-red-400' : 'text-zinc-500 dark:text-zinc-400')} aria-hidden />
      <span className={cx('min-w-0 flex-1', blocks && 'font-medium')}>{text}</span>
      {review.run_id && (
        <Link
          to={`/workspace/${review.run_id}`}
          className="rounded font-medium text-accent-700 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 dark:text-accent-300"
        >
          {blocks ? 'See what blocks' : 'Open the review'}
        </Link>
      )}
    </p>
  );
}

// ------------------------------------------------------------------ approvals waiting for the owner


/** The full approval of a gate (from the run), or what the graph knows about it. */
function gateApproval(gate: ApprovalGraphNode, graph: ExecutionGraph, run?: RunDetailResponse): ApprovalView {
  return (
    run?.approvals.find((a) => a.id === gate.approval_id) ?? {
      id: gate.approval_id,
      tool: gate.tool,
      args: gate.args as unknown as JsonValue,
      risk: gate.risk,
      reason: gate.reason,
      status: gate.status,
      run_id: gate.run_id,
      root_run_id: graph.root_run_id,
    }
  );
}

const PLAN_ANCHOR = 'workspace-plan';

const pendingGates = (graph: ExecutionGraph, plans: boolean) =>
  graph.nodes.filter((n): n is ApprovalGraphNode => n.kind === 'approval' && n.status === 'pending' && isPlanTool(n.tool) === plans);

/** A plan waiting for the owner: the first thing to see after Start. Nothing starts until it is checked. */
function PlanArea({ graph, run, model, names, onDecided }: { graph: ExecutionGraph; run?: RunDetailResponse; model: StepsModel; names: Names; onDecided: () => void }) {
  const headingId = useId();
  const plans = pendingGates(graph, true);
  if (plans.length === 0) return null;
  return (
    <>
      {plans.map((gate, index) => {
        const approval = gateApproval(gate, graph, run);
        const asker = approval.agent_id ?? stepOfRun(model, gate.run_id)?.agentId ?? model.planner.agentId;
        const name = memberName(asker, names);
        return (
          <section
            key={gate.id}
            id={index === 0 ? PLAN_ANCHOR : undefined}
            tabIndex={-1}
            aria-labelledby={`${headingId}-${gate.id}`}
            className="space-y-2 rounded-lg border border-accent-300 bg-accent-50/60 p-3 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 dark:border-accent-800 dark:bg-accent-950/30 sm:p-4"
          >
            <h2 id={`${headingId}-${gate.id}`} className="flex items-center gap-2 text-base font-semibold text-zinc-900 dark:text-zinc-50">
              <ListChecks className="h-5 w-5 shrink-0 text-accent-700 dark:text-accent-300" aria-hidden />
              {asker === COORDINATOR_ID ? `The ${name} proposes this plan` : `${name} proposes this plan`}
            </h2>
            <ApprovalCard approval={approval} onDecided={onDecided} />
          </section>
        );
      })}
    </>
  );
}

const ApprovalsArea = forwardRef<
  HTMLElement,
  { graph: ExecutionGraph; run?: RunDetailResponse; model: StepsModel; names: Names; onDecided: () => void }
>(function ApprovalsArea({ graph, run, model, names, onDecided }, ref) {
  const headingId = useId();
  const help = useHelp('What approving means');
  const gates = pendingGates(graph, false);
  if (gates.length === 0) return null;
  const askers = [...new Set(gates.map((g) => run?.approvals.find((a) => a.id === g.approval_id)?.agent_id ?? stepOfRun(model, g.run_id)?.agentId ?? model.planner.agentId))];
  const who = askers.length === 1 ? memberName(askers[0], names) : 'Your team';
  return (
    <section
      ref={ref}
      tabIndex={-1}
      aria-labelledby={headingId}
      className="space-y-3 rounded-lg border border-amber-300 bg-amber-50/70 p-3 focus:outline-none sm:p-4 focus-visible:ring-2 focus-visible:ring-amber-500 dark:border-amber-800 dark:bg-amber-950/30"
    >
      <div className="flex items-center gap-2">
        <ShieldQuestion className="h-5 w-5 shrink-0 text-amber-700 dark:text-amber-300" aria-hidden />
        <h2 id={headingId} className="text-base font-semibold text-amber-950 dark:text-amber-100">
          {gates.length === 1 ? 'Needs your approval' : `${gates.length} requests need your approval`}
        </h2>
        {help.button}
      </div>
      {help.panel(`${who} is waiting for your decision. Nothing happens until you decide; if you reject, it is not done and the work carries on without it.`)}
      <ul className="space-y-3">
        {gates.map((gate) => {
          const step = stepOfRun(model, gate.run_id);
          const approval = gateApproval(gate, graph, run);
          return (
            <li key={gate.id} className="space-y-1.5">
              {step?.node && (
                <p className="text-xs text-zinc-700 dark:text-zinc-300">
                  For the step <span className="font-medium">“{step.title}”</span> ({step.name})
                </p>
              )}
              <ApprovalCard approval={approval} onDecided={onDecided} />
            </li>
          );
        })}
      </ul>
    </section>
  );
});

// ------------------------------------------------------------------ detailed map (advanced)

function MapView({
  graph,
  run,
  events,
  selected,
  onSelectedChange,
  agentNames,
  onDecided,
}: {
  graph: ExecutionGraph;
  run?: RunDetailResponse;
  events: RunEvent[];
  selected: string | null;
  onSelectedChange: (id: string | null) => void;
  agentNames: Names;
  onDecided: () => void;
}) {
  const inspectorRef = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<string | null>(null);
  const headingId = useId();
  const names = useMemo(() => Object.fromEntries(Object.entries(agentNames).map(([id, v]) => [id, v.name ?? id])), [agentNames]);
  const select = useCallback(
    (id: string) => {
      returnFocus.current = id;
      onSelectedChange(id);
      // Like a drawer: the inspector takes the focus; Escape gives it back to the node.
      window.setTimeout(() => inspectorRef.current?.focus(), 0);
    },
    [onSelectedChange],
  );
  const close = useCallback(() => {
    onSelectedChange(null);
    const id = returnFocus.current;
    if (!id) return;
    window.setTimeout(() => {
      const node = [...document.querySelectorAll<SVGElement>('[data-node-id]')].find((el) => el.getAttribute('data-node-id') === id);
      node?.focus();
    }, 0);
  }, [onSelectedChange]);
  useEffect(() => {
    if (!selected) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || document.querySelector('[aria-modal="true"]')) return;
      close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected, close]);

  return (
    <div className={cx('grid gap-4', selected && 'xl:grid-cols-[minmax(0,1fr)_24rem]')}>
      <div className="min-w-0 space-y-2">
        <div className="h-[55vh] min-h-[320px] lg:h-[calc(100vh-20rem)] lg:min-h-[460px]">
          <OrchestrationCanvas graph={graph} selectedId={selected} onSelect={select} agentNames={names} />
        </div>
        <p className="text-xs text-zinc-500 dark:text-zinc-400">{selected ? 'Escape closes the details.' : 'Select a box to see its details.'}</p>
      </div>
      {selected && (
        <aside
          ref={inspectorRef}
          aria-labelledby={headingId}
          tabIndex={-1}
          className="fixed inset-x-0 bottom-0 z-40 flex max-h-[75vh] flex-col rounded-t-xl border-t border-zinc-200 bg-white shadow-2xl focus:outline-none dark:border-zinc-800 dark:bg-zinc-900 xl:static xl:z-auto xl:h-[calc(100vh-20rem)] xl:max-h-none xl:min-h-[460px] xl:rounded-lg xl:border xl:shadow-sm"
        >
          <NodeInspector graph={graph} nodeId={selected} run={run} events={events} onSelect={select} onClose={close} headingId={headingId} onApprovalDecided={onDecided} />
        </aside>
      )}
    </div>
  );
}
