// The end of a task: the consolidated answer when it is done, or a plain explanation and what the
// owner can do when it could not finish, was stopped or was interrupted. "Continue" starts a
// follow-up task from a finished one (POST /api/runs/{id}/follow-up).

import { useId, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Ban, CircleX, CornerDownRight, Flag, RotateCcw, ShieldAlert, TriangleAlert, Wrench } from 'lucide-react';
import { followUpRun, resumeRun } from '../../api/endpoints';
import { qk } from '../../api/keys';
import type { JsonValue, RunDetail } from '../../api/types';
import { Button, ButtonLink, Card, CardBody, CardHeader, CopyButton, Disclosure, ErrorState, Textarea } from '../../components/ui';
import { useToast } from '../../components/toast';
import { changeFactsOf, findingsOf, memberName, plainTaskText, readReport, verdictOf, type PlainReport } from '../../lib/plain';
import { ChangeFactsLines, FindingList, FullReport, IssueList, OutcomeBadge, Prose, VerdictBadge } from './ResultParts';
import { plainError, type Names } from './steps';

interface Contribution {
  agent: string;
  status?: string;
  output?: JsonValue | null;
  output_text?: string | null;
  error?: string | null;
}

/** A team run's output is {mode, contributions[], result}: the consolidated part is `result`. */
export function finalOf(run: Pick<RunDetail, 'kind' | 'output' | 'output_text'>): { report: PlainReport; raw: unknown; contributions: Contribution[] | null } {
  const output = run.output;
  if (run.kind === 'team' && output && typeof output === 'object' && !Array.isArray(output) && Array.isArray((output as Record<string, unknown>).contributions)) {
    const record = output as Record<string, unknown>;
    const result = (record.result ?? null) as unknown;
    const contributions = (record.contributions as unknown[]).filter((c): c is Contribution => !!c && typeof c === 'object' && !Array.isArray(c));
    if (result !== null) return { report: readReport(result, run.output_text), raw: result, contributions: null };
    return { report: readReport(null, null), raw: output, contributions };
  }
  return { report: readReport(output, run.output_text), raw: output, contributions: null };
}

/** The text worth copying: the answer, else the summary, else the plain output. */
function copyText(report: PlainReport, run: Pick<RunDetail, 'output_text'>): string {
  return [report.summary, report.answer].filter(Boolean).join('\n\n') || run.output_text || '';
}

export function FinalResult({ run, names }: { run: RunDetail; names: Names }) {
  const { report, raw, contributions } = finalOf(run);
  const text = copyText(report, run);
  // A security review says what it decided, and one that blocks the change does not look like a success.
  const verdict = verdictOf(run.output);
  const findings = findingsOf(run.output);
  const facts = changeFactsOf(run.output);
  const blocks = verdict === 'block';
  return (
    <Card className={blocks ? 'border-red-300 dark:border-red-900' : 'border-emerald-300 dark:border-emerald-800'}>
      <CardHeader
        title={
          <span className="inline-flex items-center gap-2 text-base">
            {blocks ? (
              <ShieldAlert className="h-4 w-4 text-red-600 dark:text-red-400" aria-hidden />
            ) : (
              <Flag className="h-4 w-4 text-emerald-600 dark:text-emerald-400" aria-hidden />
            )}
            Final result
          </span>
        }
        actions={
          <>
            <VerdictBadge verdict={verdict} />
            {(!verdict || report.outcome !== 'complete') && <OutcomeBadge outcome={report.outcome} />}
            {text ? <CopyButton text={text} label="Copy the result" /> : null}
          </>
        }
      />
      <CardBody className="space-y-3">
        {report.summary && <p className="whitespace-pre-wrap break-words text-base font-medium text-zinc-900 dark:text-zinc-50">{report.summary}</p>}
        {report.answer && <Prose text={report.answer} limit={2000} />}
        {facts && <ChangeFactsLines facts={facts} />}
        <FindingList findings={findings} />
        <IssueList issues={report.issues} />
        {contributions && (
          <ol className="space-y-2" aria-label="What each team member delivered">
            {contributions.map((c, index) => {
              const part = readReport(c.output ?? null, c.output_text);
              return (
                <li key={`${c.agent}-${index}`} className="rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
                  <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{memberName(c.agent, names)}</p>
                  {c.status && c.status !== 'completed' ? (
                    <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">{plainError(c.error, { names }) ?? 'Did not finish.'}</p>
                  ) : (
                    <div className="mt-1 space-y-1.5">
                      <OutcomeBadge outcome={part.outcome} />
                      {part.summary && <Prose text={part.summary} limit={400} />}
                      {part.answer && <Prose text={part.answer} limit={600} />}
                      <IssueList issues={part.issues} />
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
        )}
        {!report.summary && !report.answer && !contributions && <p className="text-sm text-zinc-600 dark:text-zinc-400">The team finished without writing a result.</p>}
        {(report.details || (raw !== null && typeof raw === 'object')) && (
          <Disclosure summary="Show the full result">
            <FullReport report={report} raw={raw} answerShown names={names} />
          </Disclosure>
        )}
      </CardBody>
    </Card>
  );
}

/** Failed, stopped or interrupted: what happened and what the owner can do now. */
export function TaskEnded({ run, names, projectId }: { run: RunDetail; names: Names; projectId: string | null }) {
  const queryClient = useQueryClient();
  const { notify } = useToast();
  const resume = useMutation({
    mutationFn: () => resumeRun(run.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.executionGraph(run.id) });
      void queryClient.invalidateQueries({ queryKey: qk.run(run.id) });
      void queryClient.invalidateQueries({ queryKey: [...qk.runs, 'list'] });
      notify('Continuing from where it stopped');
    },
  });
  const again = new URLSearchParams({ task: plainTaskText(run.task) });
  if (projectId) again.set('project', projectId);
  const stopped = run.status === 'cancelled';
  const interrupted = run.status === 'interrupted';
  const canContinue = run.status === 'interrupted' || run.status === 'failed';
  const title = stopped ? 'This task was stopped' : interrupted ? 'This task was interrupted' : 'This task could not be finished';
  const Icon = stopped ? Ban : interrupted ? TriangleAlert : CircleX;
  const explanation = stopped
    ? 'Steps already done keep their results.'
    : interrupted
      ? 'The platform restarted while your team was working. Nothing was lost.'
      : (plainError(run.error, { names }) ?? 'Something went wrong.');
  return (
    <Card className={stopped || interrupted ? 'border-slate-300 dark:border-slate-700' : 'border-red-300 dark:border-red-900'}>
      <CardHeader
        title={
          <span className="inline-flex items-center gap-2 text-base">
            <Icon className={stopped || interrupted ? 'h-4 w-4 text-slate-500' : 'h-4 w-4 text-red-600 dark:text-red-400'} aria-hidden /> {title}
          </span>
        }
      />
      <CardBody className="space-y-3">
        <p className="text-sm text-zinc-800 dark:text-zinc-200">{explanation}</p>
        {run.error && !interrupted && (
          <Disclosure summary="Technical details">
            <p className="whitespace-pre-wrap break-words font-mono text-xs text-zinc-700 dark:text-zinc-300">{run.error}</p>
          </Disclosure>
        )}
        <div className="flex flex-wrap items-center gap-2">
          {canContinue && (
            <Button
              variant="primary"
              icon={<RotateCcw className="h-4 w-4" />}
              loading={resume.isPending}
              onClick={() => resume.mutate()}
              title="Your team picks up from its last saved point."
            >
              {interrupted ? 'Continue' : 'Try again from where it stopped'}
            </Button>
          )}
          <ButtonLink to={`/?${again.toString()}`}>Start again</ButtonLink>
        </div>
        {resume.isError && <ErrorState compact error={resume.error} title="It could not continue" />}
      </CardBody>
    </Card>
  );
}

/** What the "Fix what blocks" button asks: it goes to whoever made the change, with the review's findings. */
export const FIX_BLOCK_MESSAGE = 'Fix every finding that blocks this change, then run the tests that cover it.';

/** True when this task is a security review that blocked a change. */
export function blockedReview(run: Pick<RunDetail, 'output'>): boolean {
  const output = run.output;
  return !!output && typeof output === 'object' && !Array.isArray(output) && (output as Record<string, unknown>).verdict === 'block';
}

/** "What next?": continue a finished task with a new instruction; opens the new task.
 *  Under a security review that blocked a change, one button sends the findings to whoever made the change. */
export function ContinueBox({ runId, fixBlock = false }: { runId: string; fixBlock?: boolean }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const id = useId();
  const [message, setMessage] = useState('');
  const follow = useMutation({
    mutationFn: (preset?: string) => followUpRun(runId, { message: preset ?? message.trim() }),
    onSuccess: ({ run_id }) => {
      void queryClient.invalidateQueries({ queryKey: [...qk.runs, 'list'] });
      void queryClient.invalidateQueries({ queryKey: qk.executions });
      navigate(`/workspace/${run_id}`);
    },
  });
  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (message.trim() && !follow.isPending) follow.mutate(undefined);
  };
  return (
    <form onSubmit={submit} aria-label="Continue this task" className="space-y-2">
      {fixBlock && (
        <Button variant="primary" icon={<Wrench className="h-4 w-4" />} loading={follow.isPending} onClick={() => follow.mutate(FIX_BLOCK_MESSAGE)}>
          Fix what blocks
        </Button>
      )}
      <div className="flex flex-wrap items-end gap-2">
        <label htmlFor={id} className="sr-only">
          What next?
        </label>
        <Textarea
          id={id}
          rows={2}
          value={message}
          maxLength={20_000}
          placeholder="What next?"
          className="min-h-0 min-w-0 flex-1 basis-64"
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) submit();
          }}
        />
        <Button type="submit" icon={<CornerDownRight className="h-4 w-4" />} loading={follow.isPending} disabled={!message.trim()}>
          Continue
        </Button>
      </div>
      {follow.isError && <ErrorState compact error={follow.error} title="It could not continue:" />}
    </form>
  );
}
