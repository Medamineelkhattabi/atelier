import { describe, expect, it } from 'vitest';
import type { ExecutionGraph, GraphNode } from '../../api/types';
import { task, workspaceGraph } from '../../test/graphFixtures';
import { DOCS_OUTPUT, RESEARCH_OUTPUT, hiringEvents, hiringGraph } from './__fixtures__/hiringTask';
import { buildSteps, cleanSummary, finalOutputs, involvedMembers, plainError, progressText, stepOfRun, stepReport } from './steps';

describe('buildSteps', () => {
  it('turns plan tasks into steps with names, hand-offs received and what they still wait for', () => {
    const model = buildSteps(hiringGraph('waiting'), { events: hiringEvents('waiting') });
    expect(model.single).toBe(false);
    expect(model.planner).toEqual({ agentId: 'orchestrator', name: 'Coordinator' });
    expect(model.steps.map((s) => [s.name, s.title, s.status])).toEqual([
      ['Researcher', 'Collect hiring constraints', 'completed'],
      ['Technical Writer', 'Write the hiring notes', 'waiting_approval'],
    ]);
    const writer = model.steps[1]!;
    expect(writer.received).toEqual([{ stepId: 'task:p1:research', agentId: 'research', name: 'Researcher', title: 'Collect hiring constraints', summary: 'Two constraints found' }]);
    expect(writer.waitingFor).toEqual([]);
    expect(writer.pendingApprovals).toBe(1);
    expect(progressText(model.counts)).toBe('1 of 2 steps done');
    expect(involvedMembers(model).map((m) => m.name)).toEqual(['Coordinator', 'Researcher', 'Technical Writer']);
    expect(stepOfRun(model, 'run-d')?.title).toBe('Write the hiring notes');
  });

  it('only lists a hand-off that really happened, and names the unmet prerequisites of a step not started', () => {
    const graph = hiringGraph('waiting');
    const pending: ExecutionGraph = {
      ...graph,
      nodes: graph.nodes.map((n) => (n.id === 'task:p1:research' ? ({ ...n, status: 'running' } as GraphNode) : n.id === 'task:p1:docs' ? ({ ...n, status: 'pending' } as GraphNode) : n)),
      edges: graph.edges.filter((e) => e.kind !== 'handoff'),
    };
    const writer = buildSteps(pending).steps[1]!;
    expect(writer.received).toEqual([]);
    expect(writer.waitingFor.map((w) => `${w.name}: ${w.title}`)).toEqual(['Researcher: Collect hiring constraints']);
  });

  it('orders steps by dependencies, then plan order, and nests the steps a team member split its work into', () => {
    const model = buildSteps(workspaceGraph());
    expect(model.steps.map((s) => s.title)).toEqual(['Map the signup code', 'Write the tests and the validation', 'Review the security impact', 'Summarise the change']);
    const engineer = model.steps[1]!;
    expect(engineer.children.map((c) => [c.title, c.level, c.name])).toEqual([
      ['Unit tests', 1, 'Tester'],
      ['Integration tests', 1, 'Tester'],
    ]);
    expect(model.all).toHaveLength(6);
    expect(model.steps[3]!.waitingFor.map((w) => w.title)).toEqual(['Write the tests and the validation', 'Review the security impact']);
    expect(progressText(model.counts)).toBe('2 of 6 steps done');
  });

  it('puts a step listed before its prerequisite after it', () => {
    const graph = workspaceGraph();
    const reordered: ExecutionGraph = { ...graph, nodes: [graph.nodes[0]!, task('late', { depends_on: ['early'], title: 'Second' }), task('early', { title: 'First' })] };
    expect(buildSteps(reordered).steps.map((s) => s.title)).toEqual(['First', 'Second']);
  });

  it('derives one step from the request itself when one team member does it alone', () => {
    const graph: ExecutionGraph = {
      ...hiringGraph('waiting'),
      agents: { research: { name: 'Researcher', responsibility: '' } },
      nodes: [
        { id: 'run:solo', kind: 'root', run_id: 'solo', agent_id: 'research', team_id: null, label: 'Researcher', status: 'running', started_at: '2026-11-11T10:00:00+00:00', finished_at: null, usage: { input_tokens: 0, output_tokens: 0, cost_usd: 0, duration_s: null, steps: 0, tool_calls: 0 }, error: null },
        { id: 'result:solo', kind: 'result', status: 'pending', output_preview: null },
      ],
      edges: [],
    };
    const model = buildSteps(graph);
    expect(model.single).toBe(true);
    expect(model.steps).toHaveLength(1);
    expect(model.steps[0]).toMatchObject({ name: 'Researcher', title: 'Working on your request', status: 'running', runId: 'solo', node: null });
    expect(model.counts.total).toBe(0);
    expect(progressText(model.counts)).toBe('');
  });
});

describe('step results', () => {
  it('reads a step’s result from its own final output, else from the preview, never from shortened JSON', () => {
    const finals = finalOutputs(hiringEvents('done'));
    expect(finals.get('run-r')?.output).toEqual(RESEARCH_OUTPUT);
    expect(stepReport({ runId: 'run-d', outputPreview: null }, finals)?.summary).toBe(DOCS_OUTPUT.summary);
    expect(stepReport({ runId: 'x', outputPreview: JSON.stringify(RESEARCH_OUTPUT) }, new Map())?.outcome).toBe('complete');
    expect(stepReport({ runId: 'x', outputPreview: 'Plain text answer' }, new Map())?.answer).toBe('Plain text answer');
    expect(stepReport({ runId: 'x', outputPreview: '{"status": "complete", "summary": "cut...' }, new Map())).toBeNull();
  });

  it('cleans hand-off summaries', () => {
    expect(cleanSummary('[partial] Half done')).toBe('Half done');
    expect(cleanSummary('{"status": "complete"')).toBe('');
    expect(cleanSummary(undefined)).toBe('');
  });
});

describe('plainError', () => {
  it('says what went wrong in one plain sentence', () => {
    const titles = new Map([['research', 'Collect hiring constraints']]);
    expect(plainError("prerequisite 'research' did not complete", { titles })).toBe('Not done, because the step “Collect hiring constraints” did not finish.');
    expect(plainError('the plan stopped after a failure')).toBe('Not started, because another step did not finish and the work stopped there.');
    expect(plainError('cancelled by the owner')).toBe('It was stopped before it finished.');
    expect(plainError('limit exceeded: max_steps = 31 (max 30)')).toBe('It reached the maximum number of actions allowed for one task.');
    expect(plainError('Subscription usage: limit reached until 2026-11-11T12:00:00.')).toMatch(/usage limit/);
    expect(plainError('internal error: KeyError: x')).toBe('Something went wrong.');
    expect(plainError(null)).toBeNull();
  });
});
