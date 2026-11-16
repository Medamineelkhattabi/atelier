// "Connect your Claude subscription": short, with the privacy note and technical detail behind a "?".
// Used by Home (only when something is wrong) and Settings (always).
//
// The sign-in button asks the platform to open Anthropic's own Claude Code sign-in window on this
// computer; the password is typed there (or in the browser), never in this app.

import { useId, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleCheck, FlaskConical, KeyRound, RefreshCw, TriangleAlert } from 'lucide-react';
import { clearUsage, listProviders, openClaudeSignIn } from '../../api/endpoints';
import { qk } from '../../api/keys';
import type { ClaudeSignInResponse } from '../../api/types';
import { Alert, Button, CopyButton, ErrorState, useHelp } from '../../components/ui';
import { cx } from '../../lib/cx';
import { formatDateTime } from '../../lib/format';
import { aiAccess, type AccessState } from './aiAccess';

/** Providers and the access state a task would use (`name`: a team member's own provider). */
export function useAiAccess(name?: string | null) {
  const query = useQuery({ queryKey: qk.providers, queryFn: listProviders, staleTime: 15_000 });
  return { query, state: aiAccess(query.data?.items, name) };
}

export const PRIVACY_SENTENCE =
  'You sign in on Anthropic’s own page: this platform never sees your password, and it only uses your Claude subscription (no API key, no pay-per-use charges).';

export function ClaudeConnection({
  state,
  onCheckAgain,
  checking = false,
  showWhenReady = false,
  className,
}: {
  state: AccessState;
  /** Re-reads the providers. */
  onCheckAgain: () => void;
  checking?: boolean;
  /** Settings shows the connected state too; Home only shows problems. */
  showWhenReady?: boolean;
  className?: string;
}) {
  const titleId = useId();
  const about = useHelp('About this connection');
  if (state.kind === 'ready') {
    if (!showWhenReady) return null;
    return <Alert tone="green" icon={<CircleCheck className="h-4 w-4" />} title="Connected to your Claude subscription" className={className} />;
  }
  if (state.kind === 'test') {
    return (
      <Alert tone="amber" icon={<FlaskConical className="h-4 w-4" />} title="Test mode: answers come from a script, not an AI model" className={className}>
        To use Claude, choose it in Settings › Advanced › Default AI settings.
      </Alert>
    );
  }
  return (
    <section
      aria-labelledby={titleId}
      className={cx('rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100', className)}
    >
      {state.kind === 'signed_out' ? (
        <SignIn titleId={titleId} help={about.button} onCheckAgain={onCheckAgain} checking={checking} />
      ) : state.kind === 'limit' ? (
        <UsageLimit titleId={titleId} help={about.button} state={state} />
      ) : (
        <Problem titleId={titleId} help={about.button} state={state} onCheckAgain={onCheckAgain} checking={checking} />
      )}
      {about.panel(
        <>
          <p>{PRIVACY_SENTENCE}</p>
          <p className="mt-1 break-words text-xs text-zinc-500 dark:text-zinc-400">{state.provider.detail}</p>
        </>,
        'mt-3',
      )}
    </section>
  );
}

function Title({ id, children, help, icon }: { id: string; children: string; help: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex items-center gap-1.5">
      <h2 id={id} className="flex min-w-0 items-center gap-2 text-base font-semibold">
        {icon ?? <KeyRound className="h-4 w-4 shrink-0" aria-hidden />}
        {children}
      </h2>
      {help}
    </div>
  );
}

function CheckAgain({ onCheckAgain, checking, primary = false }: { onCheckAgain: () => void; checking: boolean; primary?: boolean }) {
  return (
    <Button variant={primary ? 'primary' : 'secondary'} icon={<RefreshCw className="h-4 w-4" />} loading={checking} onClick={onCheckAgain}>
      Check again
    </Button>
  );
}

function SignIn({ titleId, help, onCheckAgain, checking }: { titleId: string; help: ReactNode; onCheckAgain: () => void; checking: boolean }) {
  const [result, setResult] = useState<ClaudeSignInResponse | null>(null);
  const [checked, setChecked] = useState(false);
  const open = useMutation({ mutationFn: openClaudeSignIn, onSuccess: (data) => setResult(data) });
  return (
    <div className="space-y-3">
      <Title id={titleId} help={help}>
        Connect your Claude subscription
      </Title>
      <p>Sign in once with your Claude account; it stays connected.</p>
      {!result && (
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary" size="md" loading={open.isPending} onClick={() => open.mutate()}>
            Connect my Claude subscription
          </Button>
          <CheckAgain onCheckAgain={onCheckAgain} checking={checking} />
        </div>
      )}
      {open.isError && <ErrorState compact error={open.error} title="The sign-in window could not be opened." />}
      {open.isError && <ManualCommand command="pae claude-login" />}
      {result?.opened && (
        <div role="status" className="space-y-2 rounded-md border border-amber-200 bg-white p-3 text-zinc-800 dark:border-amber-900 dark:bg-zinc-900 dark:text-zinc-200">
          <p className="font-medium">A sign-in window opened on this computer.</p>
          <p className="text-zinc-600 dark:text-zinc-400">Finish signing in there, then check again.</p>
          <div className="flex flex-wrap gap-2 pt-1">
            <CheckAgain
              primary
              checking={checking}
              onCheckAgain={() => {
                setChecked(true);
                onCheckAgain();
              }}
            />
            <Button variant="ghost" onClick={() => open.mutate()} loading={open.isPending}>
              Open the window again
            </Button>
          </div>
          {checked && !checking && (
            <p className="text-xs text-zinc-600 dark:text-zinc-400">Still not connected. Finish the sign-in window first.</p>
          )}
        </div>
      )}
      {result && !result.opened && (
        <div role="status" className="space-y-2 rounded-md border border-amber-200 bg-white p-3 text-zinc-800 dark:border-amber-900 dark:bg-zinc-900 dark:text-zinc-200">
          <p className="font-medium">The sign-in window could not be opened from here.</p>
          {result.reason && <p className="text-zinc-600 dark:text-zinc-400">{result.reason}</p>}
          <ManualCommand command={result.command} />
          <CheckAgain primary onCheckAgain={onCheckAgain} checking={checking} />
        </div>
      )}
    </div>
  );
}

function ManualCommand({ command }: { command: string }) {
  return (
    <div className="space-y-1.5">
      <p>Or run this in a terminal on the platform’s computer:</p>
      <div className="flex flex-wrap items-center gap-2">
        <code className="min-w-0 break-all rounded border border-zinc-200 bg-zinc-50 px-2 py-1 font-mono text-xs text-zinc-900 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100">
          {command}
        </code>
        <CopyButton text={command} label="Copy the command" />
      </div>
    </div>
  );
}

function UsageLimit({ titleId, help, state }: { titleId: string; help: ReactNode; state: AccessState }) {
  const queryClient = useQueryClient();
  const clear = useMutation({ mutationFn: clearUsage, onSuccess: () => void queryClient.invalidateQueries({ queryKey: qk.providers }) });
  return (
    <div className="space-y-3">
      <Title id={titleId} help={help}>
        Your Claude plan’s usage limit is reached
      </Title>
      <p>
        New work can start after <span className="font-medium">{formatDateTime(state.usage?.blocked_until)}</span>. The platform never switches to
        paid usage.
      </p>
      {state.usage?.message && <p className="text-amber-900 dark:text-amber-200">Claude said: {state.usage.message}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <Button loading={clear.isPending} onClick={() => clear.mutate()}>
          The limit has already reset
        </Button>
      </div>
      {clear.isError && <ErrorState compact error={clear.error} title="Not cleared. Try again in a moment." />}
    </div>
  );
}

function Problem({ titleId, help, state, onCheckAgain, checking }: { titleId: string; help: ReactNode; state: AccessState; onCheckAgain: () => void; checking: boolean }) {
  const text =
    state.kind === 'no_program'
      ? {
          title: 'Claude Code is not installed on this computer',
          body: 'Install Claude Code on the computer that runs the platform, then check again.',
        }
      : state.kind === 'blocked'
        ? {
            title: 'Your Claude connection is blocked for your protection',
            body: 'This computer has pay-per-use AI settings, so the platform refuses to start work. Remove them, restart the platform, then check again.',
          }
        : { title: 'Your AI access is not ready', body: state.provider.detail };
  return (
    <div className="space-y-3">
      <Title id={titleId} help={help} icon={<TriangleAlert className="h-4 w-4 shrink-0" aria-hidden />}>
        {text.title}
      </Title>
      <p>{text.body}</p>
      <CheckAgain onCheckAgain={onCheckAgain} checking={checking} />
    </div>
  );
}
