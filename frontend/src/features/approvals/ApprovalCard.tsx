// One approval request in plain words: "X wants to …", a preview, then Approve / Reject. What it
// changes, why, the task and the time left are short secondary text; an optional message is one
// click away. A proposed plan reads as numbered steps, with "Start the plan" / "Change it" (saying
// what should change is required: the Coordinator revises the plan from it).
// Tool ids, risk levels and raw arguments are in "Technical details".
// Also used inline by the run timeline and the workspace.

import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Clock, MessageSquare, Pencil, ShieldQuestion, X } from 'lucide-react';
import { decideApproval, listAgents } from '../../api/endpoints';
import { qk } from '../../api/keys';
import type { Agent, Approval, DecisionResponse } from '../../api/types';
import { useToast } from '../../components/toast';
import { Alert, Badge, Button, CodeBlock, Disclosure, ErrorState, Input, JsonBlock, KeyValue, Mono, Textarea } from '../../components/ui';
import { formatDateTime, formatDuration, formatRelative, parseTs } from '../../lib/format';
import { useNow } from '../../lib/hooks';
import { cx } from '../../lib/cx';
import { plainTaskText } from '../../lib/plain';
import { riskDescription } from '../../lib/status';
import { approvalStatus, approvalWords } from './approvalText';

export type ApprovalView = Pick<Approval, 'id' | 'tool' | 'args' | 'risk' | 'reason' | 'status'> &
  Partial<Pick<Approval, 'run_id' | 'root_run_id' | 'agent_id' | 'created_at' | 'expires_at' | 'decided_at' | 'note' | 'run_task' | 'root_task' | 'project_id'>>;

/** Time left before the request expires on its own (then the action is not done). */
export function TimeLeft({ expiresAt }: { expiresAt: string | null | undefined }) {
  const now = useNow(1000, !!expiresAt);
  const expires = parseTs(expiresAt);
  if (!expires) return null;
  const seconds = (expires.getTime() - now) / 1000;
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1 text-xs tabular-nums',
        seconds < 300 ? 'font-medium text-red-700 dark:text-red-400' : 'text-zinc-600 dark:text-zinc-400',
      )}
      title={`If nobody decides by ${formatDateTime(expiresAt)}, it is not done.`}
    >
      <Clock className="h-3.5 w-3.5" aria-hidden />
      {seconds > 0 ? `${formatDuration(seconds)} left to decide` : 'Time is up'}
    </span>
  );
}

export function ApprovalCard({
  approval,
  showRun = false,
  onDecided,
  className,
  agents,
  projectName,
  collapsePreviewWhenDecided = false,
}: {
  approval: ApprovalView;
  /** Show which task (and project) the request belongs to, with a link to open the task. */
  showRun?: boolean;
  onDecided?: (result: DecisionResponse) => void;
  className?: string;
  /** Team members, for names (fetched when not given and the request names its team member). */
  agents?: Pick<Agent, 'id' | 'name'>[];
  /** Project name shown with the task (when `showRun`). */
  projectName?: string | null;
  /** Once decided, keep the preview behind "Show …" (long lists of past decisions). */
  collapsePreviewWhenDecided?: boolean;
}) {
  const queryClient = useQueryClient();
  const { notify } = useToast();
  // Names are needed for who asks and, in a plan, for who does each step.
  const agentList = useQuery({ queryKey: qk.agents, queryFn: listAgents, staleTime: 5 * 60_000, enabled: !agents });
  const words = approvalWords(approval, agents ?? agentList.data?.items);
  const [note, setNote] = useState('');
  const [writing, setWriting] = useState(false);
  const [noteProblem, setNoteProblem] = useState<string | null>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const [choice, setChoice] = useState<boolean | null>(null);
  const mutation = useMutation({
    mutationFn: (approve: boolean) => decideApproval(approval.id, { approve, note: note.trim() || undefined }),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: qk.approvals });
      void queryClient.invalidateQueries({ queryKey: qk.dashboard });
      void queryClient.invalidateQueries({ queryKey: [...qk.runs, 'list'] });
      if (approval.run_id) void queryClient.invalidateQueries({ queryKey: qk.run(approval.run_id) });
      if (approval.root_run_id && approval.root_run_id !== approval.run_id) {
        void queryClient.invalidateQueries({ queryKey: qk.run(approval.root_run_id) });
      }
      // The card may leave the list once the request is decided: the toast keeps the confirmation visible.
      notify(confirmation(result.status));
      onDecided?.(result);
    },
  });
  const status = mutation.isSuccess ? mutation.data.status : approval.status;
  const pending = status === 'pending';
  const plain = approvalStatus(status);
  const noteId = `approval-note-${approval.id}`;
  const task = plainTaskText(approval.root_task ?? approval.run_task);
  const taskId = approval.root_run_id ?? approval.run_id;
  const { action } = words;
  const plan = action.plan ?? null;
  const subject = approval.agent_id ? words.who : 'the team member';
  function confirmation(decided: string): string {
    if (plan && decided === 'approved') return 'Plan started.';
    if (plan && decided === 'rejected') return `Sent back — ${subject} revises the plan.`;
    if (decided === 'approved') return `Approved — ${subject} goes ahead.`;
    if (decided === 'rejected') return `Rejected — ${subject} will not do it and carries on without it.`;
    return approvalStatus(decided).hint;
  }
  /** "Change it": the first click asks what should change; with an answer, it sends the plan back. */
  function changePlan() {
    if (!writing) {
      setWriting(true);
      window.setTimeout(() => noteRef.current?.focus(), 0);
      return;
    }
    if (!note.trim()) {
      setNoteProblem('Say what should change.');
      noteRef.current?.focus();
      return;
    }
    setNoteProblem(null);
    setChoice(false);
    mutation.mutate(false);
  }
  const preview =
    plan && plan.length > 0 ? (
      <ol className="space-y-1 rounded-md bg-zinc-50 px-3 py-2 text-sm text-zinc-800 dark:bg-zinc-950 dark:text-zinc-200" aria-label="Plan">
        {plan.map((step) => (
          <li key={step} className="break-words">
            {step}
          </li>
        ))}
      </ol>
    ) : action.preview ? (
      <CodeBlock maxHeight="max-h-64">{action.preview}</CodeBlock>
    ) : null;

  return (
    <article
      // Announced as what will happen ("Approval request: Create a file"), not as a tool id.
      aria-label={`Approval request: ${action.title}`}
      className={cx(
        'min-w-0 rounded-lg border bg-white p-3 dark:bg-zinc-900 sm:p-4',
        pending ? 'border-amber-300 dark:border-amber-800' : 'border-zinc-200 dark:border-zinc-800',
        className,
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h3 className="flex min-w-0 flex-1 basis-64 items-start gap-2 text-sm font-medium text-zinc-900 dark:text-zinc-100">
          <ShieldQuestion className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
          <span className="min-w-0 break-words">{words.sentence}</span>
        </h3>
        <div className="flex flex-wrap items-center gap-3">
          {pending ? (
            <TimeLeft expiresAt={approval.expires_at} />
          ) : (
            <Badge tone={plain.tone} dot title={plain.hint}>
              {plain.label}
            </Badge>
          )}
        </div>
      </div>

      <p className="mt-1 break-words pl-6 text-xs text-zinc-500 dark:text-zinc-400">
        <span>{action.effect}</span>
        {approval.reason && (
          <>
            {' '}
            <span aria-hidden>·</span> <span className="font-medium text-zinc-600 dark:text-zinc-300">Why:</span>{' '}
            <span className="whitespace-pre-wrap">{approval.reason}</span>
          </>
        )}
      </p>

      {preview &&
        (collapsePreviewWhenDecided && !pending ? (
          <Disclosure summary={`Show the ${(action.previewLabel ?? 'preview').toLowerCase()}`} className="mt-3">
            {preview}
          </Disclosure>
        ) : (
          <div className="mt-2.5">
            {!plan && <p className="mb-1 text-xs text-zinc-500 dark:text-zinc-400">{action.previewLabel ?? 'Preview'}</p>}
            {preview}
          </div>
        ))}

      {showRun && (task || taskId) && (
        <p className="mt-2.5 flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 text-xs text-zinc-500 dark:text-zinc-400">
          <span className="min-w-0 break-words">
            For your task {task ? <span className="text-zinc-800 dark:text-zinc-200">“{task.length > 160 ? `${task.slice(0, 159)}…` : task}”</span> : null}
          </span>
          {projectName && <span>· Project {projectName}</span>}
          {taskId && (
            <>
              <span aria-hidden>·</span>
              <Link to={`/workspace/${taskId}`} className="font-medium text-accent-700 hover:underline dark:text-accent-300">
                Open the task
              </Link>
            </>
          )}
        </p>
      )}

      {pending ? (
        <div className="mt-3 space-y-2">
          {writing && plan && (
            <div className="space-y-1">
              <label htmlFor={noteId} className="block text-xs font-medium text-zinc-700 dark:text-zinc-300">
                What should change?
              </label>
              <Textarea
                ref={noteRef}
                id={noteId}
                rows={2}
                value={note}
                maxLength={2000}
                placeholder="e.g. skip the research, I have the facts"
                aria-invalid={!!noteProblem}
                aria-describedby={noteProblem ? `${noteId}-problem` : undefined}
                onChange={(event) => {
                  setNote(event.target.value);
                  if (noteProblem) setNoteProblem(null);
                }}
              />
              {noteProblem && (
                <p id={`${noteId}-problem`} role="alert" className="text-xs font-medium text-red-700 dark:text-red-400">
                  {noteProblem}
                </p>
              )}
            </div>
          )}
          {writing && !plan && (
            <div className="space-y-1">
              <label htmlFor={noteId} className="block text-xs font-medium text-zinc-700 dark:text-zinc-300">
                Message to the team member (optional)
              </label>
              <Input
                id={noteId}
                value={note}
                maxLength={2000}
                placeholder="e.g. use a temporary file instead"
                onChange={(event) => setNote(event.target.value)}
              />
            </div>
          )}
          {mutation.isError && (
            <ErrorState compact error={mutation.error} title="Your decision was not recorded. Refresh the page: it may have expired or been decided." />
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="success"
              icon={<Check className="h-4 w-4" />}
              loading={mutation.isPending && choice === true}
              disabled={mutation.isPending}
              onClick={() => {
                setChoice(true);
                mutation.mutate(true);
              }}
            >
              {plan ? 'Start the plan' : 'Approve'}
            </Button>
            {plan ? (
              <Button variant="secondary" icon={<Pencil className="h-4 w-4" />} loading={mutation.isPending && choice === false} disabled={mutation.isPending} onClick={changePlan}>
                Change it
              </Button>
            ) : (
              <Button
                variant="danger"
                icon={<X className="h-4 w-4" />}
                loading={mutation.isPending && choice === false}
                disabled={mutation.isPending}
                onClick={() => {
                  setChoice(false);
                  mutation.mutate(false);
                }}
              >
                Reject
              </Button>
            )}
            {!writing && !plan && (
              <Button variant="ghost" size="xs" icon={<MessageSquare className="h-3.5 w-3.5" />} onClick={() => setWriting(true)}>
                Add a message
              </Button>
            )}
          </div>
        </div>
      ) : mutation.isSuccess ? (
        <Alert tone={mutation.data.status === 'approved' ? 'green' : 'gray'} className="mt-3">
          {confirmation(mutation.data.status)}
        </Alert>
      ) : (
        <p className="mt-2.5 text-xs text-zinc-500 dark:text-zinc-400">
          {plain.hint}
          {approval.decided_at && <> · {formatRelative(approval.decided_at)}</>}
          {approval.note && (
            <>
              {' '}
              · Message: <span className="text-zinc-800 dark:text-zinc-200">{approval.note}</span>
            </>
          )}
        </p>
      )}

      <Disclosure summary="Technical details" className="mt-2.5">
        <div className="space-y-2">
          <KeyValue
            items={[
              { label: 'Tool', value: <Mono>{approval.tool}</Mono> },
              { label: 'Risk level', value: `${approval.risk || 'not declared'} — ${riskDescription(approval.risk)}` },
              ...(approval.agent_id ? [{ label: 'Team member id', value: <Mono>{approval.agent_id}</Mono> }] : []),
              ...(approval.created_at ? [{ label: 'Requested', value: formatDateTime(approval.created_at) }] : []),
              ...(approval.expires_at ? [{ label: 'Expires', value: formatDateTime(approval.expires_at) }] : []),
              ...(approval.decided_at ? [{ label: 'Decided', value: formatDateTime(approval.decided_at) }] : []),
              { label: 'Request id', value: <Mono>{approval.id}</Mono> },
              ...(approval.run_id ? [{ label: 'Step', value: <Link to={`/runs/${approval.run_id}`} className="text-accent-700 hover:underline dark:text-accent-300">Technical details of the step</Link> }] : []),
            ]}
          />
          <p className="text-xs font-medium text-zinc-600 dark:text-zinc-400">Arguments</p>
          <JsonBlock value={approval.args} maxHeight="max-h-64" />
        </div>
      </Disclosure>
    </article>
  );
}
