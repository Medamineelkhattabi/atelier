// Is the AI access that new tasks would use ready? Read from GET /api/providers, never assumed.
// The platform's only real AI access is Claude Code on the owner's Claude subscription;
// "scripted" is a test double that answers from a script and must always be labelled as such.

import type { ProviderStatus, UsageBlock } from '../../api/types';
import { formatDateTime } from '../../lib/format';

export type AccessKind =
  /** Claude Code signed in to the owner's subscription, usable now. */
  | 'ready'
  /** The scripted test provider: no AI model is used. */
  | 'test'
  /** Claude Code is installed but not signed in. */
  | 'signed_out'
  /** The Claude Code program was not found on this computer. */
  | 'no_program'
  /** Paid API credential variables are present: the platform refuses to run. */
  | 'blocked'
  /** The plan's usage limit is reached until a given time. */
  | 'limit'
  /** The provider is not ready for another reason (shown with its own detail). */
  | 'other';

export interface AccessState {
  kind: AccessKind;
  provider: ProviderStatus;
  /** Usage block, when kind is "limit". */
  usage: UsageBlock | null;
}

export function usageBlock(provider: ProviderStatus | undefined): UsageBlock | null {
  const usage = provider?.usage;
  return usage && 'blocked_until' in usage && usage.blocked_until ? (usage as UsageBlock) : null;
}

/**
 * The state of the AI access a task would use: `name` when given (a team member's own provider),
 * otherwise the platform default. null while the providers are unknown.
 */
export function aiAccess(providers: ProviderStatus[] | undefined, name?: string | null): AccessState | null {
  if (!providers || providers.length === 0) return null;
  const provider = (name && providers.find((p) => p.name === name)) || providers.find((p) => p.is_default) || null;
  if (!provider) return null;
  if (provider.name === 'scripted') return { kind: 'test', provider, usage: null };
  const usage = usageBlock(provider);
  if (provider.configured) return { kind: 'ready', provider, usage: null };
  if (provider.name !== 'claude-code') return { kind: 'other', provider, usage: null };
  // cli_path is null (not just absent) when the backend looked for the program and did not find it.
  if (provider.cli_path === null && provider.auth !== 'blocked') return { kind: 'no_program', provider, usage: null };
  if (provider.auth === 'blocked') return { kind: 'blocked', provider, usage: null };
  if (provider.auth === 'none' || !provider.auth) return { kind: 'signed_out', provider, usage: null };
  if (usage) return { kind: 'limit', provider, usage };
  return { kind: 'other', provider, usage: null };
}

/** True when new tasks can start (a test provider can start too: it is labelled, not hidden). */
export function canStart(state: AccessState | null): boolean {
  return !!state && (state.kind === 'ready' || state.kind === 'test');
}

/** One sentence shown next to a disabled Start button. */
export function notReadyReason(state: AccessState | null): string {
  if (!state) return 'Checking your Claude connection…';
  switch (state.kind) {
    case 'ready':
    case 'test':
      return '';
    case 'signed_out':
      return 'Connect your Claude subscription first (see below).';
    case 'no_program':
      return 'Claude Code must be installed on this computer first (see below).';
    case 'blocked':
      return 'Your Claude connection is blocked for your protection (see below).';
    case 'limit':
      return `Your Claude plan’s usage limit is reached until ${formatDateTime(state.usage?.blocked_until)}.`;
    default:
      return `Your AI access is not ready: ${state.provider.detail}`;
  }
}
