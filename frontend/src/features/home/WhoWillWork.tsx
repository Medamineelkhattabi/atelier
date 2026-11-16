// "Who works on it": chosen automatically, stated in one line, changeable by name.

import { useEffect, useRef, useState } from 'react';
import type { Agent } from '../../api/types';
import { Button, Select } from '../../components/ui';
import { AgentAvatar } from '../workspace/agentAvatar';
import { COORDINATOR_ID, INTERNAL_AGENTS, memberName } from '../../lib/plain';

/** Team members the owner can hand a task to directly (enabled, not internal, not the Coordinator). */
export function pickableMembers(agents: Agent[] | undefined): Agent[] {
  return (agents ?? [])
    .filter((a) => a.enabled && a.status !== 'disabled' && !INTERNAL_AGENTS.has(a.id) && a.id !== COORDINATOR_ID)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function WhoWillWork({
  agentId,
  direct,
  onChange,
  agents,
  unavailable,
}: {
  /** null: the Coordinator decides. */
  agentId: string | null;
  /** The member who takes requests of this project directly (a code project's Software Engineer), if any. */
  direct?: string | null;
  onChange: (agentId: string | null) => void;
  agents: Agent[] | undefined;
  /** Name of a requested team member who cannot take the task (switched off or removed). */
  unavailable?: string | null;
}) {
  const [changing, setChanging] = useState(false);
  const selectRef = useRef<HTMLSelectElement>(null);
  useEffect(() => {
    if (changing) selectRef.current?.focus();
  }, [changing]);
  const members = pickableMembers(agents);
  const coordinator = memberName(COORDINATOR_ID, agents);
  const chosen = agentId ? agents?.find((a) => a.id === agentId) : undefined;
  const about = chosen?.responsibility || chosen?.description;

  return (
    <div className="space-y-1">
      <p id="who-label" className="text-sm font-medium text-zinc-800 dark:text-zinc-200">
        Who works on it
      </p>
      <div className="flex min-h-9 items-center gap-2">
        <AgentAvatar agentId={agentId ?? COORDINATOR_ID} name={agentId ? memberName(agentId, agents) : coordinator} size="sm" />
        <p className="min-w-0 flex-1 text-sm text-zinc-900 dark:text-zinc-100" aria-live="polite" title={about || undefined}>
          {agentId ? (
            <>
              <span className="font-medium">{memberName(agentId, agents)}</span> {agentId === direct ? 'works on it directly, like Claude Code.' : 'works on it.'}
            </>
          ) : (
            <>
              <span className="font-medium">{coordinator}</span> <span className="text-zinc-600 dark:text-zinc-400">picks the right specialists.</span>
            </>
          )}
        </p>
        {!changing && (
          <Button size="xs" variant="secondary" onClick={() => setChanging(true)} aria-describedby="who-label">
            Change
          </Button>
        )}
      </div>
      {unavailable && (
        <p className="text-xs text-amber-800 dark:text-amber-300">
          {unavailable} is off or gone, so your {coordinator} decides.
        </p>
      )}
      {changing && (
        <div className="flex flex-wrap items-end gap-2 pt-1">
          <div className="min-w-0 flex-1 basis-48">
            <label htmlFor="home-member" className="mb-1 block text-xs font-medium text-zinc-700 dark:text-zinc-300">
              Who should work on it?
            </label>
            <Select ref={selectRef} id="home-member" value={agentId ?? ''} onChange={(event) => onChange(event.target.value || null)}>
              <option value="">{direct ? `Let the ${coordinator} split it among the team` : `Let the ${coordinator} decide (recommended)`}</option>
              {members.map((member) => (
                <option key={member.id} value={member.id}>
                  {member.id === direct ? `${member.name} (recommended: direct, fastest)` : member.name}
                </option>
              ))}
            </Select>
          </div>
          <Button size="sm" onClick={() => setChanging(false)}>
            Done
          </Button>
        </div>
      )}
    </div>
  );
}
