// Plain-language facts about a task (a root run) for lists: who works on it, how long it took,
// and links that start it again from Home.

import type { Agent, RunSummary } from '../../api/types';
import { elapsedSeconds, formatDuration } from '../../lib/format';
import { WORK_FILTERS, memberName } from '../../lib/plain';
import { isActive } from '../../lib/status';

type Names = Pick<Agent, 'id' | 'name'>[] | undefined;

/** Who works on the task: the team member's name, or the team's name for a team task. */
export function taskWho(run: Pick<RunSummary, 'kind' | 'agent_id' | 'team_name'>, agents: Names): string {
  if (run.kind === 'team') return run.team_name ? `Team “${run.team_name}”` : 'A team';
  return memberName(run.agent_id, agents);
}

/** API statuses of a "My Work" filter, comma-separated ('' for all). */
export function filterStatuses(filterId: string): string {
  return (WORK_FILTERS.find((f) => f.id === filterId)?.statuses ?? []).join(',');
}

/** How long it took ("2m 05s"), or how long it has been working; '' when it has not started. */
export function taskDuration(run: Pick<RunSummary, 'status' | 'started_at' | 'finished_at' | 'duration_s'>, now: number): string {
  const seconds = elapsedSeconds(run, now);
  if (seconds === null) return '';
  return isActive(run.status) ? `working for ${formatDuration(seconds)}` : `took ${formatDuration(seconds)}`;
}

/** Home, pre-filled: `/?task=…&project=…&agent=…` (other screens link here, e.g. "Start again"). */
export function homeLink({ task, project, agent }: { task?: string | null; project?: string | null; agent?: string | null }): string {
  const params = new URLSearchParams();
  if (task) params.set('task', task);
  if (project) params.set('project', project);
  if (agent) params.set('agent', agent);
  const qs = params.toString();
  return qs ? `/?${qs}` : '/';
}
