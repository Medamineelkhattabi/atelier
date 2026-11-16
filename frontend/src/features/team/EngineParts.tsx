// The agents a team member can run on: Claude Code (the platform default), or an agent that speaks the
// Agent Client Protocol (Gemini CLI, Codex...), each on the owner's own sign-in. Shared by a team member's
// profile, its advanced settings and Tools & Connections.

import { Fragment } from 'react';
import { useQuery } from '@tanstack/react-query';
import { listEngines } from '../../api/endpoints';
import { qk } from '../../api/keys';
import type { Engine } from '../../api/types';
import { Mono } from '../../components/ui';

/** The provider value that means Claude Code, the platform default. */
export const CLAUDE_CODE_CHOICE = 'default';

export function useEngines() {
  return useQuery({ queryKey: qk.engines, queryFn: listEngines, staleTime: 60_000 });
}

/** Claude Code first, then the ACP agents in the order the platform lists them. */
export function orderedEngines(items: Engine[] | undefined): Engine[] {
  const list = items ?? [];
  return [...list.filter((e) => e.builtin), ...list.filter((e) => !e.builtin)];
}

/** "Your Google account" → "Runs on your Google account." */
export function runsOnText(plan: string): string {
  const trimmed = plan.trim();
  const text = /^(Your|The)\b/.test(trimmed) ? trimmed.charAt(0).toLowerCase() + trimmed.slice(1) : trimmed;
  return text ? `Runs on ${text}${/[.!?]$/.test(text) ? '' : '.'}` : '';
}

/** Text with `code` spans (as in the sign-in hints) shown as code. */
export function CodeText({ text }: { text: string }) {
  const parts = text.split('`');
  return (
    <>
      {parts.map((part, i) => (
        <Fragment key={i}>{i % 2 === 0 ? part : i < parts.length - 1 ? <Mono>{part}</Mono> : `\`${part}`}</Fragment>
      ))}
    </>
  );
}
