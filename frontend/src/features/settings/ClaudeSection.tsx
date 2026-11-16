// Settings › Claude subscription: is the AI access connected, is the plan's usage limit reached,
// and (in Technical details) what the platform knows about it. The credential itself is never read.

import { Card, CardBody, CardHeader, Disclosure, ErrorState, KeyValue, LoadingState, Mono } from '../../components/ui';
import { formatDateTime } from '../../lib/format';
import { providerLabel } from '../../lib/status';
import { aiAccess, usageBlock } from '../onboarding/aiAccess';
import { ClaudeConnection, useAiAccess } from '../onboarding/ClaudeConnection';
import { useSettings } from './SettingsForm';

const AUTH_TEXT: Record<string, string> = {
  login: 'Signed in with your Claude account',
  env_token: 'Connected with a subscription token set on this computer',
  blocked: 'Blocked: paid API settings were found on this computer',
  none: 'Not signed in',
};

export function ClaudeSection() {
  const { query, state } = useAiAccess();
  const settings = useSettings();
  const claude = query.data?.items.find((p) => p.name === 'claude-code');
  const claudeState = aiAccess(query.data?.items, 'claude-code');
  const usage = usageBlock(claude);
  const model = settings.data?.values['providers.claude_code.default_model'];

  return (
    <div className="space-y-4">
      {query.isPending ? (
        <LoadingState label="Checking your Claude connection…" />
      ) : query.isError ? (
        <ErrorState error={query.error} title="Your Claude connection could not be checked. Check that the platform is running, then try again." onRetry={() => void query.refetch()} />
      ) : (
        state && <ClaudeConnection state={state} showWhenReady onCheckAgain={() => void query.refetch()} checking={query.isFetching} />
      )}
      {state?.kind === 'test' && claudeState && (
        // Test mode is on: the subscription can still be connected now, ready for when it is switched back.
        <ClaudeConnection state={claudeState} showWhenReady onCheckAgain={() => void query.refetch()} checking={query.isFetching} />
      )}
      {claude && (
        <Card>
          <CardHeader title="Your Claude subscription" description="Through Claude Code on your own plan: no API keys, no pay-per-use charges." />
          <CardBody className="space-y-3">
            <KeyValue
              items={[
                { label: 'Connection', value: claude.cli_path === null ? 'Claude Code is not installed on this computer' : (AUTH_TEXT[claude.auth ?? 'none'] ?? claude.detail) },
                {
                  label: 'Usage limit',
                  value: usage ? `Reached — new work can start after ${formatDateTime(usage.blocked_until)}` : 'Not reached',
                },
                { label: 'Claude model', value: model ? <Mono>{model}</Mono> : 'Your plan’s default' },
              ]}
            />
            <Disclosure summary="Technical details">
              <ul className="space-y-3 text-xs text-zinc-700 dark:text-zinc-300">
                {(query.data?.items ?? []).map((p) => (
                  <li key={p.name} className="space-y-1">
                    <p className="font-medium text-zinc-900 dark:text-zinc-100">
                      {providerLabel(p.name)} <Mono className="text-zinc-500">{p.name}</Mono>
                      {p.is_default ? ' · used by default' : ''} · {p.configured ? 'ready' : 'not ready'}
                    </p>
                    <p className="break-words">{p.detail}</p>
                    {p.auth && (
                      <p>
                        Sign-in state: <Mono>{p.auth}</Mono>
                      </p>
                    )}
                    {p.cli_path !== undefined && (
                      <p className="break-all">
                        Claude Code program: <Mono>{p.cli_path ?? 'not found'}</Mono>
                      </p>
                    )}
                    {p.config_dir && (
                      <p className="break-all">
                        Claude Code home for the platform (holds the sign-in, never read by the platform): <Mono>{p.config_dir}</Mono>
                      </p>
                    )}
                    {p.policy && <p className="break-words">Policy: {p.policy}</p>}
                  </li>
                ))}
              </ul>
            </Disclosure>
          </CardBody>
        </Card>
      )}
    </div>
  );
}
