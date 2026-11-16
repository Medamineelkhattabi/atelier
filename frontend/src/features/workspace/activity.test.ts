import { describe, expect, it } from 'vitest';
import type { RunEvent } from '../../api/types';
import { event } from '../../test/utils';
import { AGENTS, hiringEvents } from './__fixtures__/hiringTask';
import { actionWords, buildActivity, type ActivityContext } from './activity';

const CONTEXT: ActivityContext = { rootRunId: 'root1', names: AGENTS, rootAgentId: 'orchestrator' };

const texts = (events: RunEvent[], context: ActivityContext = CONTEXT, every = false) =>
  buildActivity(events, context)
    .filter((item) => every || !item.everyAction)
    .map((item) => item.text);

describe('buildActivity: a whole task, from its recorded events', () => {
  it('tells the story in plain words, in order, with team member names', () => {
    expect(texts(hiringEvents('done'))).toEqual([
      'Coordinator started working on your request',
      'Coordinator split the work into 2 steps',
      'Researcher started “Collect hiring constraints”',
      'Researcher finished “Collect hiring constraints”',
      'Researcher passed its results to Technical Writer',
      'Technical Writer started “Write the hiring notes”',
      'Technical Writer asked for your approval to create the file “hiring-notes.md” in the project folder',
      'You approved: create the file “hiring-notes.md” in the project folder',
      'Technical Writer finished “Write the hiring notes”',
      'Done: the final result is ready',
    ]);
  });

  it('keeps details on a second line: the steps planned, what was handed off', () => {
    const items = buildActivity(hiringEvents('done'), CONTEXT);
    expect(items.find((i) => i.kind === 'plan')?.detail).toBe('Collect hiring constraints (Researcher) · Write the hiring notes (Technical Writer)');
    expect(items.find((i) => i.kind === 'handoff')?.detail).toBe('Two constraints found');
    expect(items.find((i) => i.kind === 'approved')?.actor).toBe('you');
    expect(items.find((i) => i.kind === 'step-start')?.actor).toEqual({ agentId: 'research', name: 'Researcher' });
  });

  it('shows nothing for what has not happened yet', () => {
    expect(texts(hiringEvents('planned'))).toEqual(['Coordinator started working on your request', 'Coordinator split the work into 2 steps']);
    const waiting = texts(hiringEvents('waiting'));
    expect(waiting[waiting.length - 1]).toBe('Technical Writer asked for your approval to create the file “hiring-notes.md” in the project folder');
    expect(waiting.join('\n')).not.toMatch(/approved|finished “Write|Done/);
    expect(buildActivity([], CONTEXT)).toEqual([]);
  });

  it('ignores technical chatter and event types it does not know', () => {
    const chatter = [
      event('step.started', 'runtime', { step: 1 }, { run_id: 'root1', root_run_id: 'root1' }),
      event('model.request', 'runtime', {}, { run_id: 'root1', root_run_id: 'root1' }),
      event('model.response', 'runtime', {}, { run_id: 'root1', root_run_id: 'root1' }),
      event('agent.reasoning', 'agent', { text: 'hidden' }, { run_id: 'root1', root_run_id: 'root1' }),
      event('task.assigned', 'runtime', { plan_id: 'p1', task_id: 'x', agent_id: 'research' }, { run_id: 'root1', root_run_id: 'root1' }),
      event('something.new', 'runtime', { text: 'never shown' }, { run_id: 'root1', root_run_id: 'root1' }),
    ];
    expect(buildActivity(chatter, CONTEXT)).toEqual([]);
  });

  it('adds tool-level actions and messages only with "Show every action"', () => {
    const every = texts(hiringEvents('done'), CONTEXT, true);
    expect(every).toContain('Coordinator said: “Research first, then documentation.”');
    expect(every).toContain('Technical Writer created the file “hiring-notes.md”');
    // The Coordinator's planning tool is the plan itself, never repeated as an action.
    expect(every.join('\n')).not.toMatch(/agent_run_plan/);
    expect(every.length - texts(hiringEvents('done')).length).toBe(2);
  });

  it('shows an action in progress until its outcome is recorded', () => {
    const started = hiringEvents('done').filter((e) => e.id <= 32);
    expect(texts(started, CONTEXT, true)).toContain('Technical Writer is about to create the file “hiring-notes.md”');
    expect(texts(hiringEvents('done'), CONTEXT, true)).not.toContain('Technical Writer is about to create the file “hiring-notes.md”');
  });
});

describe('buildActivity: problems, the owner’s controls, other shapes of work', () => {
  const base = (type: string, data: Record<string, unknown>, extra: Partial<RunEvent> = {}) => event(type, 'runtime', data, { run_id: 'root1', root_run_id: 'root1', ...extra });
  const plan = base('plan.created', {
    plan_id: 'p1',
    created_by_run_id: 'root1',
    tasks: [
      { id: 'a', agent_id: 'research', title: 'Collect facts', depends_on: [] },
      { id: 'b', agent_id: 'documentation', title: 'Write it up', depends_on: ['a'] },
    ],
  });

  it('explains retries, failures and skipped steps in plain words', () => {
    const items = buildActivity(
      [
        plan,
        base('task.retry', { plan_id: 'p1', task_id: 'a', attempt: 2, previous_error: 'run exceeded its timeout of 600s' }),
        base('task.started', { plan_id: 'p1', task_id: 'a', agent_id: 'research', child_run_id: 'run-a2', attempt: 2 }),
        base('task.failed', { plan_id: 'p1', task_id: 'a', error: 'run exceeded its timeout of 600s', attempts: 2, status: 'failed' }),
        base('task.skipped', { plan_id: 'p1', task_id: 'b', reason: "prerequisite 'a' did not complete" }),
        base('run.failed', { error: "team member 'research' ended with status failed", code: 'member_failed' }),
      ],
      CONTEXT,
    );
    expect(items.map((i) => [i.text, i.detail])).toEqual([
      ['Coordinator split the work into 2 steps', 'Collect facts (Researcher) · Write it up (Technical Writer)'],
      ['“Collect facts” did not work; Researcher is trying again', 'It took longer than the time allowed.'],
      ['Researcher started “Collect facts” again (attempt 2)', undefined],
      ['Researcher could not finish “Collect facts”', 'It took longer than the time allowed.'],
      ['“Write it up” was skipped', 'Not done, because the step “Collect facts” did not finish.'],
      ['The task could not be finished', 'Researcher could not finish their step, so the team stopped.'],
    ]);
  });

  it('records the owner’s pause, resume, rejection and stop', () => {
    const items = buildActivity(
      [
        base('run.paused', { actor: 'owner' }, { source: 'user' }),
        base('run.unpaused', { actor: 'owner' }, { source: 'user' }),
        event('approval.requested', 'runtime', { approval_id: 'a1', tool: 'shell_run', args: { command: 'rm -rf build' } }, { run_id: 'run-x', root_run_id: 'root1' }),
        event('approval.decided', 'user', { approval_id: 'a1', decision: 'rejected', note: 'not now' }, { run_id: 'run-x', root_run_id: 'root1' }),
        base('run.cancel_requested', { actor: 'owner' }, { source: 'user' }),
        base('run.cancelled', { requested: true }),
      ],
      { ...CONTEXT, runAgents: { 'run-x': 'documentation' } },
    );
    expect(items.map((i) => i.text)).toEqual([
      'You paused the work',
      'You resumed the work',
      'Technical Writer asked for your approval to run a command in the project folder',
      'You rejected: run a command in the project folder',
      'You asked to stop the work',
      'The work was stopped',
    ]);
    expect(items[3]!.detail).toBe('Your note: not now');
  });

  it('names who split a step into nested steps', () => {
    const items = buildActivity(
      [
        base('task.started', { plan_id: 'p1', task_id: 'b', agent_id: 'software-engineering', child_run_id: 'run-b', attempt: 1 }),
        event('plan.created', 'runtime', { plan_id: 'p2', created_by_run_id: 'run-b', tasks: [{ id: 'x', agent_id: 'testing', title: 'Unit tests' }, { id: 'y', agent_id: 'testing', title: 'Integration tests' }] }, { run_id: 'run-b', root_run_id: 'root1' }),
      ],
      { ...CONTEXT, names: { ...AGENTS, 'software-engineering': { name: 'Software Engineer' }, testing: { name: 'Tester' } } },
    );
    expect(items.map((i) => i.text)).toEqual(['Software Engineer started a step', 'Software Engineer split their step into 2 steps']);
  });

  it('follows a task done by one team member on its own', () => {
    const events = [
      base('run.started', { agent_id: 'research' }),
      event('agent.tool_call', 'agent', { tool_call_id: 't1', tool: 'fs_read', input: { path: 'brief.md' } }, { run_id: 'root1', root_run_id: 'root1' }),
      event('tool.completed', 'tool', { tool_call_id: 't1', tool: 'fs_read', output: '...' }, { run_id: 'root1', root_run_id: 'root1' }),
      base('run.completed', { output_preview: '{}' }),
    ];
    const context = { rootRunId: 'root1', names: AGENTS, rootAgentId: 'research' };
    expect(texts(events, context)).toEqual(['Researcher started working on your request', 'Done: the final result is ready']);
    expect(texts(events, context, true)).toContain('Researcher read the file “brief.md”');
  });

  it('describes a team without a coordinator', () => {
    const items = buildActivity(
      [base('run.started', { kind: 'team' }), base('plan.created', { plan_id: 't', created_by_run_id: 'root1', tasks: [{ id: 'm1', agent_id: 'research', title: 'Facts' }, { id: 'm2', agent_id: 'documentation', title: 'Notes' }] })],
      { rootRunId: 'root1', names: AGENTS, rootAgentId: null },
    );
    expect(items.map((i) => i.text)).toEqual(['Your team started working on your request', 'Your team’s work was split into 2 steps']);
  });
});

describe('actionWords', () => {
  it('describes common actions in plain words and leaves team tools to the plan events', () => {
    expect(actionWords('fs_search', { pattern: 'TODO' })?.done).toBe('searched the files for “TODO”');
    expect(actionWords('claude_code.Bash', { command: 'npm test' })?.done).toBe('ran the command “npm test”');
    expect(actionWords('web_fetch', { url: 'https://example.com/a' })?.done).toBe('read a web page on example.com');
    expect(actionWords('mcp__github__create_issue', {})?.todo).toBe('use “create_issue” from your connection “github”');
    expect(actionWords('agent_delegate', {})).toBeNull();
    expect(actionWords('final_answer', {})).toBeNull();
  });

  it('describes the actions of ACP agents, naming the agent', () => {
    expect(actionWords('acp.gemini.execute', { command: 'npm test' })).toEqual({
      done: 'ran the command “npm test” (Gemini CLI)',
      todo: 'run the command “npm test” (Gemini CLI)',
    });
    expect(actionWords('acp.codex.edit', { path: 'a.ts' })?.done).toBe('changed the file “a.ts” (Codex)');
    expect(actionWords('acp.codex.write_file', { path: 'b.md', content: 'x' })?.done).toBe('wrote the file “b.md” (Codex)');
    expect(actionWords('acp.codex.write_file', { diff: { path: 'c.md', oldText: null, newText: 'x' } })?.done).toBe('created the file “c.md” (Codex)');
    expect(actionWords('acp.gemini.read', {})?.done).toBe('read files (Gemini CLI)');
    expect(actionWords('acp.gemini.fetch', { url: 'https://example.com/a' })?.done).toBe('read a web page on example.com (Gemini CLI)');
    expect(actionWords('acp.gemini.other', { title: 'Update the plan' })?.done).toBe('did “Update the plan” (Gemini CLI)');
  });

  it('shows an ACP agent’s approval and actions in the activity feed', () => {
    const run = { run_id: 'run-g', root_run_id: 'root1' };
    const items = buildActivity(
      [
        event('approval.requested', 'runtime', { approval_id: 'g1', tool: 'acp.gemini.execute', args: { command: 'npm test' } }, run),
        event('approval.decided', 'user', { approval_id: 'g1', decision: 'approved' }, run),
        event('agent.tool_call', 'agent', { tool_call_id: 't1', tool: 'acp.gemini.execute', input: { command: 'npm test' } }, run),
        event('tool.completed', 'tool', { tool_call_id: 't1', tool: 'acp.gemini.execute' }, run),
      ],
      { ...CONTEXT, names: { ...AGENTS, 'software-engineering': { name: 'Software Engineer' } }, runAgents: { 'run-g': 'software-engineering' } },
    );
    expect(items.map((i) => i.text)).toEqual([
      'Software Engineer asked for your approval to run the command “npm test” (Gemini CLI)',
      'You approved: run the command “npm test” (Gemini CLI)',
      'Software Engineer ran the command “npm test” (Gemini CLI)',
    ]);
  });
});
