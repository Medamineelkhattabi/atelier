// Building blocks shared by "My AI Team", a team member's profile and Tools & Connections:
// ability icons and lists, "Works with" links, the turned-off / needs-fixing note, load errors.

import type { ComponentType } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Ban,
  CircleAlert,
  Eye,
  FilePen,
  FileText,
  FolderOpen,
  GitBranch,
  Globe,
  Hand,
  Mail,
  PencilLine,
  Plug,
  PowerOff,
  Send,
  Sheet,
  SquareTerminal,
  Users,
} from 'lucide-react';
import { listAgents, listTools } from '../../api/endpoints';
import { qk } from '../../api/keys';
import type { Agent } from '../../api/types';
import { Alert, Badge, Mono } from '../../components/ui';
import { AgentAvatar } from '../workspace/agentAvatar';
import { COORDINATOR_ID, memberName, type Ability, type AbilityKind } from '../../lib/plain';
import { cx } from '../../lib/cx';
import { canChange, memberChangeSummary, memberState } from './teamText';

export const ABILITY_ICON: Record<AbilityKind, ComponentType<{ className?: string }>> = {
  read: FolderOpen,
  documents: FileText,
  data: Sheet,
  web: Globe,
  team: Users,
  files: FilePen,
  commands: SquareTerminal,
  git: GitBranch,
  services: Send,
  email: Mail,
  connections: Plug,
};

/** The team (agents) and the tool list (for the owner's rules), shared by the team screens. */
export function useTeamData() {
  const agents = useQuery({ queryKey: qk.agents, queryFn: listAgents });
  const tools = useQuery({ queryKey: qk.tools, queryFn: listTools, staleTime: 60_000 });
  return { agents, tools };
}

/** "Asks you first" / "Blocked by you" next to an ability. Read-only abilities need no marker. */
export function AbilityMarker({ ability }: { ability: Ability }) {
  if (ability.blocked) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-red-50 px-1.5 py-0.5 text-[0.7rem] font-medium text-red-700 ring-1 ring-inset ring-red-200 dark:bg-red-950/60 dark:text-red-300 dark:ring-red-900">
        <Ban className="h-3 w-3" aria-hidden />
        Blocked by you
      </span>
    );
  }
  if (ability.asksFirst) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-1.5 py-0.5 text-[0.7rem] font-medium text-amber-800 ring-1 ring-inset ring-amber-200 dark:bg-amber-950/60 dark:text-amber-300 dark:ring-amber-900">
        <Hand className="h-3 w-3" aria-hidden />
        Asks you first
      </span>
    );
  }
  if (ability.changesThings) {
    return (
      <span className="inline-flex items-center rounded-full bg-zinc-100 px-1.5 py-0.5 text-[0.7rem] font-medium text-zinc-700 ring-1 ring-inset ring-zinc-300 dark:bg-zinc-800 dark:text-zinc-300 dark:ring-zinc-700">
        Without asking
      </span>
    );
  }
  return null;
}

export function AbilityList({ abilities, label = 'What it can do', className }: { abilities: Ability[]; label?: string; className?: string }) {
  if (abilities.length === 0) {
    return <p className={cx('text-sm text-zinc-600 dark:text-zinc-400', className)}>Works only from what you write.</p>;
  }
  return (
    <ul className={cx('space-y-1.5', className)} aria-label={label}>
      {abilities.map((ability) => {
        const Icon = ABILITY_ICON[ability.kind];
        return (
          <li key={ability.kind} className="flex items-start gap-2 text-sm">
            <Icon className={cx('mt-0.5 h-4 w-4 shrink-0', ability.blocked ? 'text-zinc-400' : 'text-zinc-500 dark:text-zinc-400')} aria-hidden />
            <span className={cx('min-w-0 flex-1', ability.blocked ? 'text-zinc-500 line-through dark:text-zinc-500' : 'text-zinc-800 dark:text-zinc-200')}>
              {ability.text}
            </span>
            <AbilityMarker ability={ability} />
          </li>
        );
      })}
    </ul>
  );
}

/** "Works with" names linking to their profiles; the technical id never shows when a name is known. */
export function WorksWithLinks({ ids, agents, className }: { ids: string[]; agents: Pick<Agent, 'id' | 'name'>[]; className?: string }) {
  if (ids.length === 0) return null;
  return (
    <ul className={cx('flex flex-wrap gap-1.5', className)} aria-label="Works with">
      {ids.map((id) => {
        const name = memberName(id, agents);
        return (
          <li key={id}>
            <Link
              to={`/team/${encodeURIComponent(id)}`}
              className="inline-flex items-center gap-1.5 rounded-full bg-white py-0.5 pl-0.5 pr-2 text-xs font-medium text-zinc-700 ring-1 ring-inset ring-zinc-300 hover:bg-zinc-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 dark:bg-zinc-900 dark:text-zinc-300 dark:ring-zinc-700 dark:hover:bg-zinc-800"
            >
              <AgentAvatar agentId={id} name={name} size="sm" />
              {name}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

/** Turned off / needs fixing, explained. Nothing when the team member is ready. */
export function MemberStateNote({ agent, showProblems = false, className }: { agent: Agent; showProblems?: boolean; className?: string }) {
  const state = memberState(agent);
  if (!state) return null;
  const Icon = state.tone === 'red' ? CircleAlert : PowerOff;
  return (
    <Alert tone={state.tone} title={state.title} icon={<Icon className="h-4 w-4" />} className={className}>
      <p>{state.text}</p>
      {showProblems && agent.problems.length > 0 && (
        <ul className="mt-1 list-inside list-disc text-xs">
          {agent.problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      )}
    </Alert>
  );
}

/** Definition files that could not be read (shown on the team page and in Settings). */
export function LoadErrors({ errors }: { errors: Record<string, string> }) {
  const entries = Object.entries(errors);
  if (entries.length === 0) return null;
  return (
    <Alert tone="red" title={`${entries.length} team member file${entries.length > 1 ? 's' : ''} could not be read`}>
      <p className="text-xs">These team members are missing until their file is fixed. The technical reason:</p>
      <ul className="mt-1 space-y-1">
        {entries.map(([file, error]) => (
          <li key={file}>
            <Mono className="font-semibold">{file}</Mono>: <span className="break-words">{error}</span>
          </li>
        ))}
      </ul>
    </Alert>
  );
}

/** "Only reads", or "Can make changes" (+ "Asks first" when every change waits for you). */
export function ChangeBadges({ agentId, abilities }: { agentId: string; abilities: Ability[] }) {
  const changes = canChange(abilities);
  const asksFirst = changes && abilities.filter((a) => a.changesThings && !a.blocked).every((a) => a.asksFirst);
  const summary = memberChangeSummary(agentId, abilities);
  if (agentId === COORDINATOR_ID && !changes) return null;
  return changes ? (
    <>
      <Badge tone="amber" title={summary}>
        <PencilLine className="h-3 w-3" aria-hidden />
        Can make changes
      </Badge>
      {asksFirst && (
        <Badge tone="gray" title={summary}>
          <Hand className="h-3 w-3" aria-hidden />
          Asks first
        </Badge>
      )}
    </>
  ) : (
    <Badge tone="green" title={summary}>
      <Eye className="h-3 w-3" aria-hidden />
      Only reads
    </Badge>
  );
}
