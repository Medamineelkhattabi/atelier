// Top of a followed task: the owner's request, its project, where it stands in plain words, how
// far it got, who is involved, Pause / Resume and Stop while it is active, the view switch and
// the link to the technical details.

import { useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, CornerUpLeft, FlaskConical, ListChecks, Map as MapIcon, Pause, Play, Radio, Wrench, WifiOff } from 'lucide-react';
import { cancelRun, getRun, pauseRun, unpauseRun } from '../../api/endpoints';
import { qk } from '../../api/keys';
import type { PauseResponse } from '../../api/types';
import { Badge, Button, ButtonLink, Card, Dialog, ErrorState, useHelp } from '../../components/ui';
import { useToast } from '../../components/toast';
import { cx } from '../../lib/cx';
import { isActive } from '../../lib/status';
import { plainTaskText, workStatus, type PlainReport, type VERDICT_LABEL } from '../../lib/plain';
import type { ConnectionState } from '../runs/useRunEvents';
import { AgentAvatar } from './agentAvatar';
import { OutcomeBadge, VerdictBadge } from './ResultParts';
import { StatusPill } from './StepsView';
import { progressText, type StepCounts } from './steps';

export type WorkspaceView = 'steps' | 'map';

const PAUSE_STOP = 'Pause: no new step starts; team members already working finish what they are doing. Stop: everything stops now.';

export function LiveBadge({ live, connection, onReconnect }: { live: boolean; connection: ConnectionState; onReconnect: () => void }) {
  if (!live) return null;
  if (connection === 'open') {
    return (
      <Badge tone="blue" title="New activity appears here as it happens.">
        <Radio className="h-3 w-3" aria-hidden /> Live
      </Badge>
    );
  }
  if (connection === 'closed' || connection === 'unsupported') {
    return (
      <span className="inline-flex items-center gap-2">
        <Badge tone="red">
          <WifiOff className="h-3 w-3" aria-hidden /> Live updates interrupted
        </Badge>
        <Button size="xs" onClick={onReconnect}>
          Reconnect
        </Button>
      </span>
    );
  }
  return <Badge tone="gray">{connection === 'reconnecting' ? 'Reconnecting…' : 'Connecting…'}</Badge>;
}

export function TaskHeader({
  rootRunId,
  request,
  status,
  paused,
  projectName,
  scripted,
  counts,
  members,
  live,
  connection,
  onReconnect,
  view,
  onViewChange,
  onPausedChange,
  outcome = null,
  verdict = null,
  followUpOf = null,
}: {
  rootRunId: string;
  request: string;
  status: string;
  paused: boolean;
  projectName: string | null;
  scripted: boolean;
  counts: StepCounts;
  members: { agentId: string; name: string }[];
  live: boolean;
  connection: ConnectionState;
  onReconnect: () => void;
  view: WorkspaceView;
  onViewChange: (view: WorkspaceView) => void;
  onPausedChange: (paused: boolean) => void;
  /** For a finished task: how complete the team says the result is. */
  outcome?: PlainReport['outcome'];
  /** For a finished security review: what it decided (shown before "Fully done"). */
  verdict?: keyof typeof VERDICT_LABEL | null;
  /** The earlier task this one continues. */
  followUpOf?: string | null;
}) {
  const queryClient = useQueryClient();
  const { notify } = useToast();
  const [confirmStop, setConfirmStop] = useState(false);
  const explainId = useId();
  const controlsHelp = useHelp('About these controls');
  const plain = workStatus(status, { paused });
  const active = isActive(status);
  const progress = progressText(counts);
  const toggle = useMutation<PauseResponse, Error, boolean>({
    mutationFn: (pause) => (pause ? pauseRun(rootRunId) : unpauseRun(rootRunId)),
    onSuccess: (response) => onPausedChange(response.paused),
  });
  const stop = useMutation({
    mutationFn: () => cancelRun(rootRunId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.executionGraph(rootRunId) });
      void queryClient.invalidateQueries({ queryKey: qk.run(rootRunId) });
      void queryClient.invalidateQueries({ queryKey: qk.executions });
      void queryClient.invalidateQueries({ queryKey: [...qk.runs, 'list'] });
      notify('Stopping: team members stop at their next safe point.', 'info');
      setConfirmStop(false);
    },
  });

  return (
    <Card>
      <div className="space-y-2.5 p-4">
        <div className="min-w-0">
          <RequestText text={request} />
          {followUpOf && <FollowsLink runId={followUpOf} />}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <StatusPill status={plain} />
          {status === 'completed' && <VerdictBadge verdict={verdict} />}
          {status === 'completed' && (!verdict || outcome !== 'complete') && <OutcomeBadge outcome={outcome} />}
          {projectName && <Badge tone="accent">Project: {projectName}</Badge>}
          {scripted && (
            <Badge tone="amber" title="A test run: a fixed script plays the team members. Files, permissions and approvals are real; no AI model is used.">
              <FlaskConical className="h-3 w-3" aria-hidden /> Test run, no AI model
            </Badge>
          )}
          <LiveBadge live={live} connection={connection} onReconnect={onReconnect} />
        </div>
        {(counts.total > 0 || members.length > 0) && (
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
            {counts.total > 0 && (
              <div className="flex items-center gap-2">
                <div
                  className="flex h-1.5 w-28 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800 sm:w-40"
                  role="progressbar"
                  aria-label="Steps done"
                  aria-valuemin={0}
                  aria-valuemax={counts.total}
                  aria-valuenow={counts.completed}
                  aria-valuetext={progress}
                >
                  <div className="bg-emerald-500" style={{ width: `${(counts.completed / counts.total) * 100}%` }} />
                  <div className="bg-red-500" style={{ width: `${(counts.failed / counts.total) * 100}%` }} />
                  <div className="bg-blue-500" style={{ width: `${(counts.active / counts.total) * 100}%` }} />
                </div>
                <span className="text-xs text-zinc-600 dark:text-zinc-400">{progress}</span>
              </div>
            )}
            {members.length > 0 && (
              <ul className="flex flex-wrap items-center -space-x-1" aria-label="Who is involved">
                {members.map((m) => (
                  <li key={m.agentId} className="inline-flex">
                    <AgentAvatar agentId={m.agentId} name={m.name} size="sm" />
                    <span className="sr-only">{m.name}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-zinc-100 px-4 py-3 dark:border-zinc-800">
        <div role="group" aria-label="View" className="inline-flex rounded-md bg-zinc-100 p-0.5 dark:bg-zinc-800">
          {(
            [
              { id: 'steps', label: 'Steps', icon: ListChecks },
              { id: 'map', label: 'Detailed map', icon: MapIcon },
            ] as const
          ).map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              aria-pressed={view === id}
              onClick={() => onViewChange(id)}
              className={cx(
                'inline-flex h-8 items-center gap-1.5 rounded px-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500',
                view === id
                  ? 'bg-white text-zinc-900 shadow-sm dark:bg-zinc-950 dark:text-zinc-50'
                  : 'text-zinc-600 hover:text-zinc-900 dark:text-zinc-300 dark:hover:text-zinc-50',
              )}
            >
              <Icon className="h-4 w-4" aria-hidden />
              {label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {active && controlsHelp.button}
          {active &&
            (paused ? (
              <Button variant="primary" icon={<Play className="h-4 w-4" />} loading={toggle.isPending} aria-describedby={explainId} onClick={() => toggle.mutate(false)}>
                Resume
              </Button>
            ) : (
              <Button icon={<Pause className="h-4 w-4" />} loading={toggle.isPending} aria-describedby={explainId} onClick={() => toggle.mutate(true)}>
                Pause
              </Button>
            ))}
          {active && (
            <Button variant="danger" icon={<Ban className="h-4 w-4" />} aria-describedby={explainId} onClick={() => setConfirmStop(true)}>
              Stop
            </Button>
          )}
          <ButtonLink to={`/runs/${rootRunId}`} variant="ghost" icon={<Wrench className="h-4 w-4" />}>
            Technical details
          </ButtonLink>
        </div>
      </div>
      {active && (
        <>
          <p id={explainId} className="sr-only">
            {PAUSE_STOP}
          </p>
          {controlsHelp.panel(PAUSE_STOP, 'mx-4 mb-3')}
        </>
      )}
      {(toggle.isError || stop.isError) && (
        <div className="px-4 pb-3">
          <ErrorState compact error={toggle.error ?? stop.error} title={toggle.isError ? (paused ? 'Could not resume' : 'Could not pause') : 'Could not stop'} />
        </div>
      )}
      <Dialog
        open={confirmStop}
        onClose={() => setConfirmStop(false)}
        title="Stop this task?"
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmStop(false)}>
              Keep working
            </Button>
            <Button variant="danger" loading={stop.isPending} onClick={() => stop.mutate()}>
              Stop the task
            </Button>
          </>
        }
      >
        Steps that have not started will not run; results already delivered are kept. You can start the task again later.
      </Dialog>
    </Card>
  );
}

/** "Follows: <earlier request>": opens the task this one continues. */
function FollowsLink({ runId }: { runId: string }) {
  const earlier = useQuery({ queryKey: qk.run(runId), queryFn: () => getRun(runId), staleTime: 60_000 });
  const text = earlier.data ? plainTaskText(earlier.data.run.task) : '';
  return (
    <Link
      to={`/workspace/${encodeURIComponent(runId)}`}
      className="mt-0.5 inline-flex max-w-full items-center gap-1 text-xs text-zinc-500 hover:text-accent-700 hover:underline dark:text-zinc-400 dark:hover:text-accent-300"
    >
      <CornerUpLeft className="h-3.5 w-3.5 shrink-0" aria-hidden />
      <span className="truncate">Follows: {text ? `“${text.length > 100 ? `${text.slice(0, 99)}…` : text}”` : 'an earlier task'}</span>
    </Link>
  );
}

/** The request as the title of the page section; a long one is shortened, with "Read everything". */
function RequestText({ text }: { text: string }) {
  const [all, setAll] = useState(false);
  const long = text.length > 320;
  return (
    <>
      <h2 className="mt-0.5 whitespace-pre-wrap break-words text-base font-semibold text-zinc-900 dark:text-zinc-50">
        {long && !all ? `${text.slice(0, 280).trimEnd()}…` : text}
      </h2>
      {long && (
        <button
          type="button"
          onClick={() => setAll((v) => !v)}
          className="mt-1 rounded text-xs font-medium text-accent-700 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 dark:text-accent-300"
        >
          {all ? 'Show less' : 'Read everything'}
        </button>
      )}
    </>
  );
}
