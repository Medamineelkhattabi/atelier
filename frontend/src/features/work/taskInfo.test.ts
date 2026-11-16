import { describe, expect, it } from 'vitest';
import { firstBracket, untouchedPlaceholders } from '../home/templateText';
import { AGENTS, run } from './testFixtures';
import { filterStatuses, homeLink, taskDuration, taskWho } from './taskInfo';

describe('task facts', () => {
  it('names who works on a task, never by id when the name is known', () => {
    expect(taskWho(run('a', 'x'), AGENTS)).toBe('Researcher');
    expect(taskWho(run('a', 'x', { agent_id: 'orchestrator' }), AGENTS)).toBe('Coordinator');
    expect(taskWho(run('a', 'x', { agent_id: 'new-helper' }), AGENTS)).toBe('New helper');
    expect(taskWho(run('a', 'x', { kind: 'team', agent_id: null, team_name: 'Writers' }), AGENTS)).toBe('Team “Writers”');
  });

  it('maps My Work filters to API statuses', () => {
    expect(filterStatuses('all')).toBe('');
    expect(filterStatuses('failed')).toBe('failed,interrupted');
    expect(filterStatuses('unknown')).toBe('');
  });

  it('says how long a task took, or how long it has been working', () => {
    expect(taskDuration(run('a', 'x'), Date.now())).toBe('took 2m 05s');
    const started = run('a', 'x', { status: 'running', finished_at: null, duration_s: null, started_at: '2026-11-11T10:00:00+00:00' });
    expect(taskDuration(started, Date.parse('2026-11-11T10:00:30Z'))).toBe('working for 30 s');
    expect(taskDuration(run('a', 'x', { status: 'queued', started_at: null, finished_at: null, duration_s: null }), Date.now())).toBe('');
  });

  it('builds Home links that prefill the request', () => {
    expect(homeLink({})).toBe('/');
    expect(homeLink({ task: 'Find prices & more', project: 'alpha', agent: 'research' })).toBe('/?task=Find+prices+%26+more&project=alpha&agent=research');
  });

  it('finds the [bracket] to replace in a suggested request', () => {
    expect(firstBracket('Find out [what] and [why].')).toEqual({ start: 9, end: 15 });
    expect(firstBracket('No brackets')).toBeNull();
    expect(untouchedPlaceholders('Find out [what] and why.', 'Find out [what] and [why].')).toEqual(['[what]']);
    expect(untouchedPlaceholders('anything [x]', null)).toEqual([]);
  });
});
