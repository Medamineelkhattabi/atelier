import { describe, expect, it } from 'vitest';
import { RESEARCH_SCHEMA, TEAM, agentFor, toolInfo } from './fixtures';
import { canChange, combinePermission, deliverables, memberAbilities, memberState, reportsOutcome, searchScore, searchTeam } from './teamText';

describe('owner rules on a team member', () => {
  it('follows the gate: a block anywhere wins, then the owner’s rule beats the team member’s', () => {
    expect(combinePermission(null, 'ask')).toBe('ask');
    expect(combinePermission('allow', 'ask')).toBe('allow');
    expect(combinePermission('allow', 'deny')).toBe('deny');
    expect(combinePermission('deny', 'allow')).toBe('deny');
    expect(combinePermission(undefined, null)).toBeNull();
  });

  it('shows an ability as blocked or allowed once the owner decided', () => {
    const engineer = agentFor('software-engineering', 'Software Engineer', { tools: ['fs_read', 'fs_write'] });
    expect(memberAbilities(engineer).find((a) => a.kind === 'files')).toMatchObject({ asksFirst: true, blocked: false });
    const blocked = memberAbilities(engineer, [toolInfo('fs_write', { global_permission: 'deny' })]);
    expect(blocked.find((a) => a.kind === 'files')).toMatchObject({ blocked: true });
    expect(canChange(blocked)).toBe(false);
    const allowed = memberAbilities(engineer, [toolInfo('fs_write', { global_permission: 'allow' })]);
    expect(allowed.find((a) => a.kind === 'files')).toMatchObject({ asksFirst: false, blocked: false });
  });
});

describe('team search', () => {
  it('matches plain requests on what each one does and when it is useful', () => {
    const reviewer = TEAM.find((a) => a.id === 'code-review')!;
    expect(searchScore(reviewer, 'Find bugs')).toBeGreaterThan(0);
    expect(searchScore(reviewer, '')).toBe(1);
    expect(searchScore(reviewer, 'spreadsheet')).toBe(0);
    expect(searchTeam(TEAM, 'sources').map((a) => a.id)).toEqual(['research']);
    expect(searchTeam(TEAM, 'plan steps').map((a) => a.id)[0]).toBe('planning');
  });
});

describe('team member state', () => {
  it('explains turned-off and broken team members', () => {
    expect(memberState({ enabled: true, problems: [], status: 'ready' })).toBeNull();
    expect(memberState({ enabled: false, problems: [], status: 'disabled' })?.title).toBe('Turned off');
    expect(memberState({ enabled: true, problems: ['unknown tool'], status: 'misconfigured' })?.title).toBe('Needs fixing');
  });
});

describe('what you get back', () => {
  it('turns an output schema into plain deliverables, without the shared status and issues', () => {
    expect(deliverables(RESEARCH_SCHEMA)).toEqual([
      'A short summary',
      'Findings, each with its sources',
      'The list of sources it read',
      'Open questions that still need an answer',
    ]);
    expect(reportsOutcome(RESEARCH_SCHEMA)).toBe(true);
    expect(deliverables(null)).toEqual([]);
  });

  it('reads the kind of findings from their fields, and falls back to descriptions or the field name', () => {
    const schema = {
      properties: {
        findings: { type: 'array', items: { properties: { file: {}, line: {}, issue: {} } } },
        quality_issues: { type: 'array' },
        release_notes: { type: 'string', description: 'Notes for the release' },
        next_owner: { type: 'string' },
      },
    };
    expect(deliverables(schema)).toEqual([
      'Problems found, each with the file and line that prove it',
      'Data quality problems it found',
      'Notes for the release',
      'Next owner',
    ]);
  });
});
