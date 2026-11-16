// The plain "Steps" view: one compact card per step, in dependency order: who does it, its status,
// what it received from another team member, what it still waits for, a one-line result and
// "Show the full result". Nested steps (a team member that split its own work) are indented.

import { useId, useState, type MouseEvent, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowDownRight, Hourglass, RotateCcw, ShieldQuestion, Timer } from 'lucide-react';
import { getRun } from '../../api/endpoints';
import { qk } from '../../api/keys';
import { Alert, Badge, Disclosure, ErrorState, Spinner } from '../../components/ui';
import { cx } from '../../lib/cx';
import { formatDuration, parseTs } from '../../lib/format';
import { useNow } from '../../lib/hooks';
import { OUTCOME_LABEL, readReport, workStatus, type PlainReport, type PlainStatus } from '../../lib/plain';
import { AgentAvatar } from './agentAvatar';
import { FullReport, IssueList, OutcomeBadge, Prose } from './ResultParts';
import { plainError, stepReport, type Names, type Step, type StepsModel } from './steps';

type Finals = Map<string, { output: unknown; outputText: string | null }>;

const ACTIVE = new Set(['running', 'waiting_approval', 'retrying', 'queued']);

/** The DOM id of a step card (links from "Received from" jump to it). */
export function stepAnchor(stepId: string): string {
  return `step-${stepId.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
}

/** A step's status in plain words, with a hint that fits its situation. */
export function stepStatus(step: Pick<Step, 'status' | 'waitingFor' | 'node'>, paused: boolean): PlainStatus {
  if (!step.node) return workStatus(step.status, { paused });
  const base = workStatus(step.status);
  if (step.status === 'pending') {
    if (paused) return { ...base, hint: 'Paused: it starts after you resume.' };
    if (step.waitingFor.length) return { ...base, hint: 'Starts when the steps it depends on are done.' };
    return { ...base, hint: 'Starts as soon as a team member is free.' };
  }
  if (paused && (step.status === 'running' || step.status === 'retrying')) {
    return { ...base, hint: 'Pausing does not interrupt a step already in progress: it finishes what it is doing.' };
  }
  return base;
}

export function StatusPill({ status, className }: { status: PlainStatus; className?: string }) {
  return (
    <Badge tone={status.tone} dot className={className} title={status.hint}>
      {status.label}
    </Badge>
  );
}

export interface StepsViewProps {
  model: StepsModel;
  paused: boolean;
  /** Overall task status (root run). */
  taskStatus: string;
  finals: Finals;
  names: Names;
  /** Titles of every step by plan task id, per plan (for plain error messages). */
  titlesOf: (planId: string) => Map<string, string>;
  /** Jump to the approvals area. */
  onShowApprovals?: () => void;
}

export function StepsView({ model, paused, taskStatus, finals, names, titlesOf, onShowApprovals }: StepsViewProps) {
  const active = ACTIVE.has(taskStatus);
  const allDone = !model.single && model.counts.total > 0 && model.all.every((s) => ['completed', 'failed', 'skipped', 'cancelled'].includes(s.status));
  const count = `${model.steps.length} step${model.steps.length === 1 ? '' : 's'}`;
  const team = model.planner.name === 'Your team' ? 'Your team' : `The team “${model.planner.name}”`;
  const intro = model.single
    ? model.planner.agentId
      ? active
        ? `${model.planner.name} is working on this.`
        : taskStatus === 'completed'
          ? `${model.planner.name} handled this on their own.`
          : `${model.planner.name} worked on this on their own.`
      : `${team} is getting ready.`
    : model.planner.agentId
      ? `${model.planner.name} split your request into ${count}.`
      : model.steps.length === 1
        ? `${team} handed the work to ${model.steps[0]!.name}.`
        : `${team} works on it in ${count}.`;
  return (
    <section aria-labelledby="steps-heading" className="space-y-3">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <h2 id="steps-heading" className="text-base font-semibold text-zinc-900 dark:text-zinc-50">
          Steps
        </h2>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">{intro}</p>
        {allDone && active && model.planner.agentId && (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">{model.planner.name} is putting the final result together.</p>
        )}
      </div>
      <StepList steps={model.steps} level={0} prefix="" paused={paused} finals={finals} names={names} titlesOf={titlesOf} single={model.single} onShowApprovals={onShowApprovals} />
    </section>
  );
}

function StepList({
  steps,
  level,
  prefix,
  ...rest
}: {
  steps: Step[];
  level: number;
  prefix: string;
  paused: boolean;
  finals: Finals;
  names: Names;
  titlesOf: (planId: string) => Map<string, string>;
  single: boolean;
  onShowApprovals?: () => void;
}) {
  return (
    <ol className="space-y-3" aria-label={level === 0 ? 'Steps' : undefined}>
      {steps.map((step, index) => (
        <StepCard key={step.id} step={step} number={`${prefix}${index + 1}`} last={index === steps.length - 1} {...rest} />
      ))}
    </ol>
  );
}

function useDuration(step: Step): number | null {
  const running = ACTIVE.has(step.status);
  const now = useNow(1000, running && !!step.startedAt);
  if (!running) return step.durationS;
  const start = parseTs(step.startedAt);
  return start ? Math.max(0, (now - start.getTime()) / 1000) : step.durationS;
}

function StepCard({
  step,
  number,
  last,
  paused,
  finals,
  names,
  titlesOf,
  single,
  onShowApprovals,
}: {
  step: Step;
  number: string;
  last: boolean;
  paused: boolean;
  finals: Finals;
  names: Names;
  titlesOf: (planId: string) => Map<string, string>;
  single: boolean;
  onShowApprovals?: () => void;
}) {
  const titleId = useId();
  const status = stepStatus(step, paused);
  const duration = useDuration(step);
  const running = ACTIVE.has(step.status);
  const report = step.status === 'completed' && !single ? stepReport(step, finals) : null;
  // A task done by one team member explains its end in the result card above, not here.
  const plainErr = step.status !== 'completed' && step.node ? plainError(step.error, { titles: titlesOf(step.node.plan_id), names }) : null;
  // While a step is still at work, its error is the previous attempt's.
  const error = plainErr && running ? `The previous attempt did not work: ${plainErr.charAt(0).toLowerCase()}${plainErr.slice(1)}` : plainErr;
  // The hint only when it adds something: why a step has not started yet, or that pausing lets it finish.
  // Otherwise it stays in the status badge's tooltip.
  const showHint =
    !!status.hint && !!step.node && !error && ((step.status === 'pending' && step.waitingFor.length === 0) || (paused && running));
  return (
    <li id={stepAnchor(step.id)} tabIndex={-1} className="relative pl-10 focus:outline-none">
      {/* The rail: a numbered dot per step, joined to the next one. */}
      {!last && <span aria-hidden className="absolute bottom-[-0.75rem] left-[0.9rem] top-8 w-px bg-zinc-200 dark:bg-zinc-700" />}
      <span
        aria-hidden
        className={cx(
          'absolute left-0 top-1 flex h-7 min-w-[1.75rem] items-center justify-center rounded-full border bg-white px-1 text-xs font-semibold tabular-nums text-zinc-700 dark:bg-zinc-900 dark:text-zinc-200',
          step.status === 'completed' ? 'border-emerald-400' : step.status === 'failed' ? 'border-red-400' : running ? 'border-blue-400' : 'border-zinc-300 dark:border-zinc-600',
        )}
      >
        {number}
      </span>
      <article
        aria-labelledby={titleId}
        className={cx(
          'rounded-lg border bg-white p-3 shadow-sm dark:bg-zinc-900',
          step.status === 'waiting_approval' ? 'border-amber-300 dark:border-amber-800' : 'border-zinc-200 dark:border-zinc-800',
        )}
      >
        <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
          <div className="flex min-w-0 flex-1 items-start gap-2.5">
            {step.agentId ? <AgentAvatar agentId={step.agentId} name={step.name} /> : null}
            <div className="min-w-0">
              <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{step.name}</p>
              <h3 id={titleId} className="break-words text-sm text-zinc-700 dark:text-zinc-300">
                <span className="sr-only">Step {number}: </span>
                {step.title}
              </h3>
            </div>
          </div>
          <span className="flex flex-wrap items-center gap-1.5">
            {/* "Fully done" goes without saying next to "Done" (it is in the tooltip); partly done or blocked is shown. */}
            {report?.outcome && report.outcome !== 'complete' && <OutcomeBadge outcome={report.outcome} />}
            <StatusPill status={report?.outcome === 'complete' ? { ...status, hint: `${status.hint} ${OUTCOME_LABEL.complete.hint}` } : status} />
          </span>
        </div>
        {showHint && <p className="mt-1.5 text-xs text-zinc-500 dark:text-zinc-400">{status.hint}</p>}

        {step.received.length > 0 && (
          <ul className="mt-2.5 space-y-1.5" aria-label="Received from other team members">
            {step.received.map((r) => (
              <li key={r.stepId} className="flex items-start gap-2 rounded-md bg-teal-50 px-2.5 py-1 text-sm text-teal-950 dark:bg-teal-950/40 dark:text-teal-100">
                <ArrowDownRight className="mt-0.5 h-4 w-4 shrink-0 text-teal-700 dark:text-teal-300" aria-hidden />
                <span className="line-clamp-2 min-w-0 break-words">
                  Received from{' '}
                  <a href={`#${stepAnchor(r.stepId)}`} onClick={(event) => jumpTo(event, r.stepId)} className="font-semibold underline decoration-teal-400 underline-offset-2 hover:decoration-2">
                    {r.name}
                  </a>
                  {r.summary ? `: ${r.summary}` : ` (the result of “${r.title}”)`}
                </span>
              </li>
            ))}
          </ul>
        )}

        {step.waitingFor.length > 0 && (
          <p className="mt-2.5 flex items-start gap-2 text-sm text-zinc-700 dark:text-zinc-300">
            <Hourglass className="mt-0.5 h-4 w-4 shrink-0 text-zinc-500" aria-hidden />
            <span className="min-w-0">
              Waiting for{' '}
              {step.waitingFor.map((w, index) => (
                <span key={w.stepId}>
                  {index > 0 && (index === step.waitingFor.length - 1 ? ' and ' : ', ')}
                  <a href={`#${stepAnchor(w.stepId)}`} onClick={(event) => jumpTo(event, w.stepId)} className="font-medium underline underline-offset-2">
                    {w.name}
                  </a>{' '}
                  (“{w.title}”)
                </span>
              ))}
            </span>
          </p>
        )}

        {step.pendingApprovals > 0 && (
          <p className="mt-2.5 flex items-start gap-2 text-sm text-amber-900 dark:text-amber-200">
            <ShieldQuestion className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <span>
              {step.name} is waiting for your approval.{' '}
              {onShowApprovals && (
                <button type="button" onClick={onShowApprovals} className="font-medium underline underline-offset-2">
                  Review
                </button>
              )}
            </span>
          </p>
        )}

        {error && (
          <Alert tone={step.status === 'failed' ? 'red' : 'gray'} className="mt-2.5">
            <p>{error}</p>
            {step.error && (
              <Disclosure summary="Technical details" className="mt-1">
                <p className="whitespace-pre-wrap break-words font-mono text-xs">{step.error}</p>
              </Disclosure>
            )}
          </Alert>
        )}

        {report && <StepGlance report={report} />}
        {(() => {
          const facts =
            step.attempts > 1 || (duration !== null && step.startedAt) ? (
              <span className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-500 dark:text-zinc-400">
                {step.attempts > 1 && (
                  <span className="inline-flex items-center gap-1">
                    <RotateCcw className="h-3.5 w-3.5" aria-hidden /> Tried {step.attempts} times
                  </span>
                )}
                {duration !== null && step.startedAt && (
                  <span className="inline-flex items-center gap-1">
                    <Timer className="h-3.5 w-3.5" aria-hidden />
                    {running ? `Working for ${formatDuration(duration)}` : `Took ${formatDuration(duration)}`}
                  </span>
                )}
              </span>
            ) : null;
          if (step.status === 'completed' && !single && step.runId) {
            return <StepFullResult runId={step.runId} report={report} finals={finals} names={names} facts={facts} />;
          }
          return facts ? <div className="mt-2 flex">{facts}</div> : null;
        })()}

        {step.children.length > 0 && (
          <div className="mt-3 border-t border-zinc-100 pt-3 dark:border-zinc-800">
            <p className="mb-2 text-sm text-zinc-700 dark:text-zinc-300">
              {step.name} split this into {step.children.length} step{step.children.length === 1 ? '' : 's'}:
            </p>
            <StepList steps={step.children} level={step.level + 1} prefix={`${number}.`} paused={paused} finals={finals} names={names} titlesOf={titlesOf} single={false} onShowApprovals={onShowApprovals} />
          </div>
        )}
      </article>
    </li>
  );
}

function jumpTo(event: MouseEvent<HTMLAnchorElement>, stepId: string) {
  const target = document.getElementById(stepAnchor(stepId));
  if (!target) return;
  event.preventDefault();
  target.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
  target.focus({ preventScroll: true });
}

/** A finished step at a glance: one short line (its summary, or the start of its answer), and its problems. */
function StepGlance({ report }: { report: PlainReport }) {
  return (
    <div className="mt-2 space-y-2">
      {report.summary ? (
        <p className="line-clamp-2 break-words text-sm text-zinc-800 dark:text-zinc-200" title={report.summary}>
          {report.summary}
        </p>
      ) : report.answer ? (
        <Prose text={report.answer} limit={200} className="text-sm" />
      ) : null}
      <IssueList issues={report.issues} />
    </div>
  );
}

/** "Show the full result": the run's own final output (from the events, or fetched when needed). */
function StepFullResult({
  runId,
  report,
  finals,
  names,
  facts,
}: {
  runId: string;
  report: PlainReport | null;
  finals: Finals;
  names: Names;
  /** Attempts and duration, shown on the same row as the button. */
  facts?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const final = finals.get(runId);
  const id = useId();
  const query = useQuery({ queryKey: qk.run(runId), queryFn: () => getRun(runId), enabled: open && !final, staleTime: 60_000 });
  const raw = final ? (final.output ?? final.outputText) : query.data ? (query.data.run.output ?? query.data.run.output_text) : null;
  const full = final ? readReport(final.output, final.outputText) : query.data ? readReport(query.data.run.output, query.data.run.output_text) : null;
  return (
    <div className="mt-2">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen((v) => !v)}
          className="rounded text-sm font-medium text-accent-700 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 dark:text-accent-300"
        >
          {open ? 'Hide the full result' : 'Show the full result'}
        </button>
        {facts}
      </div>
      {open && (
        <div id={id} className="mt-2 rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
          {full ? (
            <FullReport report={full} raw={raw} answerShown={!!report && !report.summary && !!report.answer} names={names} />
          ) : query.isError ? (
            <ErrorState compact error={query.error} title="The full result could not be loaded" onRetry={() => void query.refetch()} />
          ) : (
            <Spinner label="Loading the full result" />
          )}
        </div>
      )}
    </div>
  );
}
