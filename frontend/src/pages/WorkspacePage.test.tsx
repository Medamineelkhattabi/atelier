import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import type { ExecutionGraph, RunDetailResponse, RunEvent } from '../api/types';
import { ProjectProvider } from '../features/projects/ProjectContext';
import { AGENTS, APPROVAL, REQUEST, hiringEvents, hiringGraph, hiringRun } from '../features/workspace/__fixtures__/hiringTask';
import { agentFixture, runDetail, usage, workspaceGraph } from '../test/graphFixtures';
import { MockEventSource, event, mockFetch, renderWithProviders } from '../test/utils';
import { VIEW_STORAGE_KEY, WorkspacePage, changesGraph } from './WorkspacePage';

const AGENT_LIST = {
  items: [
    agentFixture({ id: 'orchestrator', name: 'Coordinator' }),
    agentFixture({ id: 'research', name: 'Researcher' }),
    agentFixture({ id: 'documentation', name: 'Technical Writer' }),
    agentFixture({ id: 'security', name: 'Security Engineer' }),
  ],
  load_errors: {},
};

function setup({
  graph = hiringGraph('waiting'),
  run = hiringRun('waiting'),
  events = [] as RunEvent[],
  extra = {} as Record<string, unknown>,
}: { graph?: ExecutionGraph; run?: RunDetailResponse; events?: RunEvent[]; extra?: Record<string, unknown> } = {}) {
  let graphCalls = 0;
  const fetch = mockFetch({
    'GET /api/runs/root1/graph': () => {
      graphCalls += 1;
      return { body: graph };
    },
    'GET /api/runs/root1': run,
    'GET /api/runs/root1/events': { events },
    'GET /api/agents': AGENT_LIST,
    'GET /api/projects': { items: [] },
    'POST /api/runs/root1/pause': { paused: true },
    'POST /api/runs/root1/cancel': { status: 'cancelling' },
    ...extra,
  });
  renderWithProviders(
    <Routes>
      <Route path="/workspace/:runId" element={<WorkspacePage />} />
      <Route path="/workspace" element={<p>All tasks</p>} />
    </Routes>,
    { route: '/workspace/root1' },
  );
  return { ...fetch, graphCalls: () => graphCalls };
}

async function openStream() {
  const stream = await vi.waitFor(() => {
    const source = MockEventSource.find('/api/runs/root1/stream');
    if (!source) throw new Error('stream not opened yet');
    return source;
  });
  act(() => stream.open());
  return stream;
}

const stepCards = () => within(screen.getByRole('list', { name: 'Steps' })).getAllByRole('article');

beforeEach(() => {
  MockEventSource.install();
  window.localStorage.clear();
});

describe('Live Workspace: a task in progress (steps view)', () => {
  it('shows the request, where it stands, who is involved and each step in plain words', async () => {
    setup();
    expect(await screen.findByRole('heading', { name: REQUEST })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Live Workspace' })).toBeInTheDocument();
    expect(screen.getByText('1 of 2 steps done')).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Steps done' })).toHaveAttribute('aria-valuenow', '1');
    expect(within(screen.getByRole('list', { name: 'Who is involved' })).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'COCoordinator',
      'REResearcher',
      'TWTechnical Writer',
    ]);
    expect(screen.getByText('Coordinator split your request into 2 steps.')).toBeInTheDocument();
    // The scripted test double stays labelled.
    expect(screen.getByText('Test run, no AI model')).toBeInTheDocument();

    const [research, writer] = stepCards();
    expect(research).toHaveAccessibleName('Step 1: Collect hiring constraints');
    expect(within(research!).getByText('Researcher')).toBeInTheDocument();
    // "Fully done" goes without saying next to "Done": it is in the status tooltip, not a second badge.
    expect(within(research!).getByText('Done')).toHaveAttribute('title', 'Finished. Fully handled, says the team.');
    expect(within(research!).queryByText('Fully done')).not.toBeInTheDocument();
    expect(within(research!).getByText('Two constraints found')).toBeInTheDocument();
    expect(within(research!).getByText('Took 5.0 s')).toBeInTheDocument();

    expect(writer).toHaveAccessibleName('Step 2: Write the hiring notes');
    expect(within(writer!).getByText('Needs your approval')).toBeInTheDocument();
    expect(within(writer!).getByRole('list', { name: 'Received from other team members' })).toHaveTextContent('Received from Researcher: Two constraints found');
    expect(within(writer!).getByRole('link', { name: 'Researcher' })).toHaveAttribute('href', '#step-task-p1-research');
    expect(within(writer!).getByText(/Technical Writer is waiting for your approval/)).toBeInTheDocument();

    // No technical ids or jargon in the plain view.
    const plain = `${screen.getByRole('list', { name: 'Steps' }).textContent} ${screen.getByRole('list', { name: 'Who is involved' }).textContent}`;
    expect(plain).not.toMatch(/\borchestrator\b|\bdocumentation\b|run-r|task:p1|execution|delegat/i);
  });

  it('puts what waits for the owner at the top, explained, with inline approve and reject', async () => {
    const { calls } = setup({ extra: { 'POST /api/approvals/appr-1/decision': { id: 'appr-1', status: 'approved' } } });
    const area = await screen.findByRole('region', { name: 'Needs your approval' });
    expect(area).not.toHaveTextContent('Nothing happens until you decide');
    await userEvent.click(within(area).getByRole('button', { name: 'What approving means' }));
    expect(area).toHaveTextContent('Nothing happens until you decide');
    expect(within(area).getByText(/For the step/)).toHaveTextContent('For the step “Write the hiring notes” (Technical Writer)');
    expect(within(area).getByRole('button', { name: 'Reject' })).toBeInTheDocument();
    await userEvent.click(within(area).getByRole('button', { name: 'Approve' }));
    await vi.waitFor(() => expect(calls.find((c) => c.path === '/api/approvals/appr-1/decision')).toMatchObject({ method: 'POST', body: { approve: true } }));
  });

  it('builds the activity from the live events as they arrive, with every action on demand', async () => {
    setup();
    await screen.findByRole('heading', { name: REQUEST });
    const stream = await openStream();
    const log = screen.getByRole('log', { name: 'Activity' });
    expect(within(log).getByText('Nothing has been recorded yet.')).toBeInTheDocument();

    for (const e of hiringEvents('planned')) act(() => stream.emit(e));
    expect(await within(log).findByText('Coordinator split the work into 2 steps')).toBeInTheDocument();
    expect(within(log).queryByText(/passed its results/)).not.toBeInTheDocument();

    for (const e of hiringEvents('waiting').slice(12)) act(() => stream.emit(e));
    expect(await within(log).findByText('Researcher passed its results to Technical Writer')).toBeInTheDocument();
    expect(within(log).getByText('Technical Writer asked for your approval to create the file “hiring-notes.md” in the project folder')).toBeInTheDocument();
    expect(within(log).queryByText(/Coordinator said/)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('switch', { name: 'Show every action' }));
    expect(within(log).getByText('Coordinator said: “Research first, then documentation.”')).toBeInTheDocument();
  });

  it('refetches the graph when a task event arrives on the live stream, and not for chatter', async () => {
    const { graphCalls } = setup();
    await screen.findByRole('heading', { name: REQUEST });
    expect(graphCalls()).toBe(1);
    const stream = await openStream();
    expect(await screen.findByText('Live')).toBeInTheDocument();

    act(() => stream.emit(event('agent.message', 'agent', { text: 'thinking' }, { run_id: 'run-d', root_run_id: 'root1' })));
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(graphCalls()).toBe(1);

    act(() => stream.emit(event('task.started', 'runtime', { plan_id: 'p1', task_id: 'docs', agent_id: 'documentation', child_run_id: 'run-d', attempt: 1 }, { root_run_id: 'root1' })));
    await vi.waitFor(() => expect(graphCalls()).toBe(2), { timeout: 2000 });
  });

  it('explains pause and asks before stopping', async () => {
    const { calls } = setup();
    await screen.findByRole('heading', { name: REQUEST });
    // The explanation is one click away (and always given to screen readers with the buttons).
    expect(screen.getByRole('button', { name: 'Pause' })).toHaveAccessibleDescription(/Pause: no new step starts; team members already working finish/);
    await userEvent.click(screen.getByRole('button', { name: 'About these controls' }));
    expect(screen.getAllByText(/Pause: no new step starts; team members already working finish/)).toHaveLength(2);
    await userEvent.click(screen.getByRole('button', { name: 'Pause' }));
    await vi.waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '/api/runs/root1/pause')).toBe(true));

    await userEvent.click(screen.getByRole('button', { name: 'Stop' }));
    const dialog = screen.getByRole('dialog', { name: 'Stop this task?' });
    expect(calls.some((c) => c.path === '/api/runs/root1/cancel')).toBe(false);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Stop the task' }));
    await vi.waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '/api/runs/root1/cancel')).toBe(true));
    expect(screen.getByRole('link', { name: 'Technical details' })).toHaveAttribute('href', '/runs/root1');
  });

  it('shows the nested steps a team member split its work into, indented under its step', async () => {
    setup({ graph: workspaceGraph(), run: runDetail() });
    await screen.findByRole('list', { name: 'Steps' });
    const top = within(screen.getByRole('list', { name: 'Steps' }))
      .getAllByRole('article')
      .map((a) => a.getAttribute('aria-labelledby') && a.querySelector('h3')?.textContent);
    expect(top).toEqual([
      'Step 1: Map the signup code',
      'Step 2: Write the tests and the validation',
      'Step 2.1: Unit tests',
      'Step 2.2: Integration tests',
      'Step 3: Review the security impact',
      'Step 4: Summarise the change',
    ]);
    expect(screen.getByText('Software engineer split this into 2 steps:')).toBeInTheDocument();
    const last = stepCards()[5]!;
    expect(last).toHaveTextContent('Waiting for Software engineer (“Write the tests and the validation”) and Security reviewer (“Review the security impact”)');
    const retried = stepCards()[4]!;
    expect(within(retried).getByText('Tried 2 times')).toBeInTheDocument();
    expect(within(retried).getByText('The previous attempt did not work: it took longer than the time allowed.')).toBeInTheDocument();
  });
});

describe('Live Workspace: the end of a task', () => {
  it('shows the consolidated final result first, with the full result on demand, and no controls', async () => {
    setup({ graph: hiringGraph('done'), run: hiringRun('done'), events: hiringEvents('done') });
    expect(await screen.findByRole('heading', { name: /Final result/ })).toBeInTheDocument();
    expect(screen.getByText('Notes written from the research.')).toBeInTheDocument();
    expect(screen.getByText('hiring-notes.md written')).toBeInTheDocument();
    expect(screen.getAllByText('Fully done').length).toBe(2); // header and final result
    expect(screen.getByRole('button', { name: 'Copy the result' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Pause' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: /approval/ })).not.toBeInTheDocument();
    expect(screen.getByText('2 of 2 steps done')).toBeInTheDocument();

    const log = screen.getByRole('log', { name: 'Activity' });
    expect(await within(log).findByText('Done: the final result is ready')).toBeInTheDocument();
    expect(within(log).getByText('You approved: create the file “hiring-notes.md” in the project folder')).toBeInTheDocument();

    const final = screen.getByRole('heading', { name: /Final result/ }).closest('section')!;
    await userEvent.click(within(final).getByRole('button', { name: 'Show the full result' }));
    expect(within(final).getByText('Validation')).toBeInTheDocument();

    // Each step's own result, read from its recorded final output (no extra request).
    const research = stepCards()[0]!;
    await userEvent.click(within(research).getByRole('button', { name: 'Show the full result' }));
    expect(within(research).getByText('Findings')).toBeInTheDocument();
    expect(within(research).getByText('Candidates are anonymised')).toBeInTheDocument();
  });

  it('shows how complete the team says the result is, and each problem once, in plain words', async () => {
    const graph = hiringGraph('done');
    graph.nodes = graph.nodes.map((n) =>
      n.id === 'task:p1:research'
        ? { ...n, status: 'failed', error: 'model call failed: brief unreadable', output_preview: null }
        : n.id === 'task:p1:docs'
          ? { ...n, status: 'skipped', error: "prerequisite 'research' did not complete", output_preview: null, started_at: null }
          : n,
    ) as ExecutionGraph['nodes'];
    graph.edges = graph.edges.filter((e) => e.kind !== 'handoff');
    const run = hiringRun('done');
    run.run = { ...run.run, output: { status: 'blocked', summary: 'No notes: the research step failed.', steps: [], result: '', validation: [], issues: ['The brief could not be read.'] } };
    setup({ graph, run });
    expect(await screen.findByText('No notes: the research step failed.')).toBeInTheDocument();
    expect(screen.getAllByText('Could not be done').length).toBe(2); // header and final result
    expect(screen.getByText('0 of 2 steps done · 1 could not be finished · 1 skipped')).toBeInTheDocument();
    const [research, writer] = stepCards();
    expect(within(research!).getByText('The team member did not get a usable answer from the AI model.')).toBeInTheDocument();
    expect(within(research!).queryByText(/Something went wrong/)).not.toBeInTheDocument();
    expect(within(writer!).getByText('Not done, because the step “Collect hiring constraints” did not finish.')).toBeInTheDocument();
    expect(within(writer!).queryByText('Not done, because an earlier step did not finish.')).not.toBeInTheDocument();
    expect(within(screen.getByRole('list', { name: 'What is missing or uncertain' })).getByText('The brief could not be read.')).toBeInTheDocument();
  });

  it('explains an interrupted task and offers to continue it or start again', async () => {
    const graph = { ...hiringGraph('waiting'), status: 'interrupted' as const };
    const run = hiringRun('waiting');
    run.run = { ...run.run, status: 'interrupted', error: 'server restart' };
    const { calls } = setup({ graph, run, extra: { 'POST /api/runs/root1/resume': { status: 'queued' } } });
    expect(await screen.findByRole('heading', { name: /This task was interrupted/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Start again' })).toHaveAttribute('href', '/?task=Prepare+hiring+notes+for+the+pipeline&project=hiring');
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await vi.waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '/api/runs/root1/resume')).toBe(true));
  });

  it('says in plain words why a task could not be finished, with the technical message on demand', async () => {
    const graph = { ...hiringGraph('waiting'), status: 'failed' as const };
    const run = hiringRun('waiting');
    run.run = { ...run.run, status: 'failed', error: "team member 'research' ended with status failed" };
    setup({ graph, run });
    const ended = (await screen.findByRole('heading', { name: /This task could not be finished/ })).closest('section')!;
    expect(within(ended).getByText('Researcher could not finish their step, so the team stopped.')).toBeInTheDocument();
    expect(screen.queryByText(/ended with status failed/)).not.toBeInTheDocument();
    await userEvent.click(within(ended).getByRole('button', { name: 'Technical details' }));
    expect(within(ended).getByText("team member 'research' ended with status failed")).toBeInTheDocument();
    expect(within(ended).getByRole('button', { name: 'Try again from where it stopped' })).toBeInTheDocument();
  });
});

describe('Live Workspace: a task done by one team member', () => {
  const soloGraph = (status: 'running' | 'completed'): ExecutionGraph => ({
    root_run_id: 'root1',
    project_id: null,
    status,
    paused: false,
    title: 'Summarise the project brief',
    last_event_id: 3,
    agents: { research: AGENTS.research },
    nodes: [
      { id: 'run:root1', kind: 'root', run_id: 'root1', agent_id: 'research', team_id: null, label: 'Researcher', status, started_at: '2026-11-11T10:00:00+00:00', finished_at: status === 'completed' ? '2026-11-11T10:00:09+00:00' : null, usage: usage({ duration_s: status === 'completed' ? 9 : null }), error: null },
      { id: 'result:root1', kind: 'result', status: status === 'completed' ? 'completed' : 'pending', output_preview: null },
    ],
    edges: [{ id: 'c', source: 'run:root1', target: 'result:root1', kind: 'consolidates', active: false }],
  });
  const soloRun = (status: 'running' | 'completed') =>
    runDetail({ agent_id: 'research', task: 'Summarise the project brief', status, output: null, output_text: status === 'completed' ? 'The brief asks for anonymised candidates.' : null });

  it('shows one step for that team member, then its result', async () => {
    setup({ graph: soloGraph('running'), run: soloRun('running') });
    const [only] = await vi.waitFor(() => stepCards());
    expect(stepCards()).toHaveLength(1);
    expect(only).toHaveAccessibleName('Step 1: Working on your request');
    expect(within(only!).getByText('Researcher')).toBeInTheDocument();
    expect(within(only!).getByText('Working')).toBeInTheDocument();
    expect(screen.getByText('Researcher is working on this.')).toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();

    const stream = await openStream();
    act(() => stream.emit(event('run.started', 'runtime', { agent_id: 'research' }, { run_id: 'root1', root_run_id: 'root1' })));
    expect(await within(screen.getByRole('log', { name: 'Activity' })).findByText('Researcher started working on your request')).toBeInTheDocument();
  });

  it('shows the plain text result as the final result', async () => {
    setup({ graph: soloGraph('completed'), run: soloRun('completed') });
    expect(await screen.findByText('The brief asks for anonymised candidates.')).toBeInTheDocument();
    expect(screen.getByText('Researcher handled this on their own.')).toBeInTheDocument();
  });
});

describe('Live Workspace: detailed map', () => {
  it('keeps the graph as an advanced view, remembered per browser', async () => {
    setup({ graph: workspaceGraph(), run: runDetail() });
    await screen.findByRole('list', { name: 'Steps' });
    expect(screen.getByRole('button', { name: 'Steps' })).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(screen.getByRole('button', { name: 'Detailed map' }));
    expect(screen.getByRole('region', { name: 'Detailed map' })).toBeInTheDocument();
    expect(window.localStorage.getItem(VIEW_STORAGE_KEY)).toBe('map');

    await userEvent.click(screen.getByRole('button', { name: /^Step: Review the security impact/ }));
    const details = await screen.findByRole('complementary');
    expect(within(details).getByRole('heading', { name: 'Step' })).toBeInTheDocument();
    expect(within(details).getByText('Checks input handling for injection risks.')).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
  });
});

describe('changesGraph', () => {
  it('refreshes on plan, task, hand-off, approval and run events only', () => {
    for (const type of ['plan.created', 'task.completed', 'handoff', 'approval.requested', 'run.paused', 'run.completed']) {
      expect(changesGraph(type)).toBe(true);
    }
    for (const type of ['agent.message', 'model.request', 'tool.started']) expect(changesGraph(type)).toBe(false);
  });
});

describe('Live Workspace: without a task selected', () => {
  const PROJECT = {
    id: 'alpha',
    name: 'Alpha',
    description: '',
    workspace: 'C:\\data\\workspaces\\alpha',
    context: '',
    tags: [],
    archived: false,
    created_at: '2026-11-01T10:00:00+00:00',
    updated_at: '2026-11-01T10:00:00+00:00',
    stats: { runs: 0, active: 0, last_run_at: null },
  };

  function setupLanding() {
    window.localStorage.setItem('pae.selectedProject', 'alpha');
    const active = hiringRun('waiting').run;
    const solo = runDetail({ id: 'solo1', root_run_id: 'solo1', agent_id: 'research', task: 'Summarise the project brief', status: 'completed', finished_at: '2026-11-11T10:05:00+00:00' }).run;
    const fetch = mockFetch({
      'GET /api/agents': { items: [agentFixture({ id: 'orchestrator', name: 'Coordinator' }), agentFixture({ id: 'research', name: 'Researcher', works_with: [] }), agentFixture({ id: 'documentation', name: 'Technical Writer' })], load_errors: {} },
      'GET /api/teams': { items: [] },
      'GET /api/projects': { items: [PROJECT] },
      'GET /api/runs': (call: { query: Record<string, string> }) => ({ body: call.query.status?.startsWith('queued') ? { total: 1, items: [active] } : { total: 1, items: [solo] } }),
      'GET /api/workspace/executions': {
        items: [
          {
            run_id: 'root1',
            title: REQUEST,
            kind: 'agent',
            agent_id: 'orchestrator',
            team_name: null,
            project_id: 'alpha',
            status: 'running',
            paused: false,
            created_at: '2026-11-11T10:00:00+00:00',
            finished_at: null,
            agents: ['documentation', 'orchestrator', 'research'],
            tasks: { total: 2, completed: 1, failed: 0, skipped: 0, running: 1 },
            active_runs: 1,
            pending_approvals: 1,
          },
        ],
      },
      'GET /api/providers': { items: [{ name: 'claude-code', description: '', default_model: null, is_default: true, configured: true, detail: 'Signed in', auth: 'login' }] },
      'GET /api/workspaces': { default: 'C:\\data\\workspaces\\default', roots: [{ root: 'C:\\data\\workspaces', directories: [] }] },
      'POST /api/runs': { run_id: 'new-root' },
    });
    renderWithProviders(
      <ProjectProvider>
        <Routes>
          <Route path="/workspace" element={<WorkspacePage />} />
          <Route path="/workspace/:runId" element={<p>Opened task</p>} />
        </Routes>
      </ProjectProvider>,
      { route: '/workspace' },
    );
    return fetch;
  }

  it('lists every task of the project in progress and recently finished, in plain words', async () => {
    const { calls } = setupLanding();
    expect(screen.getByText('Follow your AI team as it works.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Start a new task' })).toHaveAttribute('href', '/');

    const inProgress = await screen.findByRole('list', { name: 'In progress' });
    const item = within(inProgress).getByRole('link', { name: /Prepare hiring notes/ });
    expect(item).toHaveAttribute('href', '/workspace/root1');
    expect(item).toHaveTextContent('Coordinator, Technical Writer, Researcher');
    expect(await within(item).findByText('1 of 2 steps done')).toBeInTheDocument();
    expect(within(item).getByText('Needs your approval')).toBeInTheDocument();
    expect(within(item).getByText('Working')).toBeInTheDocument();

    // A task done by one team member is listed too (not only team work).
    const finished = await screen.findByRole('list', { name: 'Recently finished' });
    const soloItem = within(finished).getByRole('link', { name: /Summarise the project brief/ });
    expect(soloItem).toHaveTextContent('Researcher');
    expect(within(soloItem).getByText('Done')).toBeInTheDocument();

    const runCalls = calls.filter((c) => c.path === '/api/runs');
    expect(runCalls.every((c) => c.query.root_only === 'true' && c.query.project_id === 'alpha')).toBe(true);
    expect(runCalls.map((c) => c.query.status).sort()).toEqual(['completed,failed,cancelled,interrupted', 'queued,running,waiting_approval']);
  });

  it('starts tasks from Home only: no manual team launcher here', async () => {
    setupLanding();
    await screen.findByRole('list', { name: 'In progress' });
    expect(screen.queryByRole('button', { name: /choose the team yourself/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Launch' })).not.toBeInTheDocument();
  });
});

describe('Live Workspace: checking the plan', () => {
  const PLAN_ARGS = {
    tasks: [
      { id: 'research', agent_id: 'research', title: 'Collect hiring constraints', task: 'List them.', depends_on: [], reason: 'facts' },
      { id: 'docs', agent_id: 'documentation', title: 'Write the hiring notes', task: 'Write them.', depends_on: ['research'], reason: 'writes' },
    ],
    max_parallel: 2,
    stop_on_failure: true,
  };

  function planGraph(): ExecutionGraph {
    const graph = hiringGraph('waiting');
    const root = { ...graph.nodes[0]!, status: 'waiting_approval' } as ExecutionGraph['nodes'][number];
    return {
      ...graph,
      status: 'waiting_approval',
      nodes: [
        root,
        { id: 'approval:plan-1', kind: 'approval', approval_id: 'plan-1', run_id: 'root1', attached_to: 'run:root1', tool: 'agent_run_plan', risk: 'read', status: 'pending', reason: 'Research first.', args: PLAN_ARGS },
        { id: 'result:root1', kind: 'result', status: 'pending', output_preview: null },
      ] as ExecutionGraph['nodes'],
      edges: [],
    };
  }

  function planRun(): RunDetailResponse {
    const run = hiringRun('waiting');
    return {
      ...run,
      run: { ...run.run, status: 'waiting_approval' },
      tree: [run.tree[0]!],
      approvals: [{ ...APPROVAL, id: 'plan-1', run_id: 'root1', agent_id: 'orchestrator', tool: 'agent_run_plan', args: PLAN_ARGS, risk: 'read', reason: 'Research first.', run_task: REQUEST }],
    };
  }

  it('shows the proposed plan first, as numbered steps; "Change it" needs what should change', async () => {
    const { calls } = setup({ graph: planGraph(), run: planRun(), extra: { 'POST /api/approvals/plan-1/decision': { id: 'plan-1', status: 'rejected' } } });
    const plan = await screen.findByRole('region', { name: 'The Coordinator proposes this plan' });
    const card = within(plan).getByRole('article', { name: 'Approval request: Check the plan' });
    expect(within(card).getByRole('heading', { name: 'Coordinator wants to start this plan (2 steps).' })).toBeInTheDocument();
    expect(within(within(card).getByRole('list', { name: 'Plan' })).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      '1. Researcher — Collect hiring constraints',
      '2. Technical Writer — Write the hiring notes (after 1)',
    ]);
    // It is the first thing after the request: before the steps and the activity, and not mixed with other approvals.
    expect(plan.compareDocumentPosition(screen.getByRole('heading', { name: 'Steps' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Needs your approval' })).not.toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(within(card).getByRole('button', { name: 'Change it' }));
    await user.click(within(card).getByRole('button', { name: 'Change it' }));
    expect(within(card).getByRole('alert')).toHaveTextContent('Say what should change.');
    expect(calls.some((c) => c.path === '/api/approvals/plan-1/decision')).toBe(false);
    await user.type(within(card).getByLabelText('What should change?'), 'Skip the research');
    await user.click(within(card).getByRole('button', { name: 'Change it' }));
    await vi.waitFor(() => expect(calls.find((c) => c.path === '/api/approvals/plan-1/decision')?.body).toEqual({ approve: false, note: 'Skip the research' }));
  });
});

describe('Live Workspace: continuing a finished task', () => {
  it('continues with a new instruction as a new task, which links back to the one it follows', async () => {
    const followUp = hiringRun('waiting');
    followUp.run = {
      ...followUp.run,
      id: 'next1',
      task: 'Add the salary range\n\n## Earlier task this continues\nEarlier request: Prepare hiring notes',
      follow_up_of: 'root1',
    };
    const { calls } = setup({
      graph: hiringGraph('done'),
      run: hiringRun('done'),
      events: hiringEvents('done'),
      extra: {
        'POST /api/runs/root1/follow-up': { run_id: 'next1', follow_up_of: 'root1' },
        'GET /api/runs/next1/graph': { ...hiringGraph('waiting'), root_run_id: 'next1', title: 'Add the salary range' },
        'GET /api/runs/next1': followUp,
        'GET /api/runs/next1/events': { events: [] },
      },
    });
    const user = userEvent.setup();
    const box = await screen.findByRole('form', { name: 'Continue this task' });
    expect(within(box).getByRole('button', { name: 'Continue' })).toBeDisabled();
    await user.type(within(box).getByPlaceholderText('What next?'), 'Add the salary range');
    await user.click(within(box).getByRole('button', { name: 'Continue' }));
    await vi.waitFor(() => expect(calls.find((c) => c.path === '/api/runs/root1/follow-up')?.body).toEqual({ message: 'Add the salary range' }));

    expect(await screen.findByRole('heading', { name: 'Add the salary range' })).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: `Follows: “${REQUEST}”` })).toHaveAttribute('href', '/workspace/root1');
  });

  it('under a security review that blocked a change, one button sends the findings to the engineer', async () => {
    const review = hiringRun('done');
    review.run = { ...review.run, output: { status: 'complete', summary: 'The export is open to everyone.', verdict: 'block', findings: [] } };
    const { calls } = setup({
      graph: hiringGraph('done'),
      run: review,
      events: hiringEvents('done'),
      extra: {
        'POST /api/runs/root1/follow-up': { run_id: 'next1', follow_up_of: 'root1' },
        'GET /api/runs/next1/graph': { ...hiringGraph('waiting'), root_run_id: 'next1', title: 'Fix what blocks' },
        'GET /api/runs/next1': hiringRun('waiting'),
        'GET /api/runs/next1/events': { events: [] },
      },
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Fix what blocks' }));
    await vi.waitFor(() =>
      expect(calls.find((c) => c.path === '/api/runs/root1/follow-up')?.body).toEqual({
        message: 'Fix every finding that blocks this change, then run the tests that cover it.',
      }),
    );
  });

  it('shows what a security review decided: a block is red, with the findings in sight, never "Fully done"', async () => {
    const review = hiringRun('done');
    review.run = {
      ...review.run,
      task: 'Security review: Add an export\n\n## What to review\nThe change the Software Engineer just made (task abc).',
      output: {
        status: 'complete',
        summary: 'The export is open to everyone.',
        verdict: 'block',
        findings: [
          { severity: 'low', category: 'logs', file: 'app/log.py', line: 3, issue: 'verbose log', exploit: '', fix: 'log less' },
          { severity: 'high', category: 'access', file: 'app/export.py', line: 12, issue: 'no role check', exploit: 'GET /export', fix: 'require the admin role' },
        ],
      },
    };
    setup({ graph: hiringGraph('done'), run: review, events: hiringEvents('done') });
    expect(await screen.findByRole('heading', { name: 'Security review: Add an export' })).toBeInTheDocument();
    expect((await screen.findAllByText('Blocks the change')).length).toBeGreaterThan(0);
    expect(screen.queryByText('Fully done')).not.toBeInTheDocument();
    const found = within(screen.getByRole('list', { name: 'What the review found' })).getAllByRole('listitem');
    expect(found).toHaveLength(2);
    expect(found[0]).toHaveTextContent('High');
    expect(found[0]).toHaveTextContent('no role check');
    expect(found[0]).toHaveTextContent('app/export.py:12');
    expect(found[0]).toHaveTextContent('Fix: require the admin role');
    expect(found[1]).toHaveTextContent('verbose log');
  });

  it('under a code change, says where its security review stands and leads to it', async () => {
    const change = hiringRun('done');
    change.run = {
      ...change.run,
      output: {
        status: 'complete',
        summary: 'Export added.',
        files_changed: ['app/export.py', 'tests/test_export.py'],
        verification: { command: 'pytest', result: '3 failed', passed: false },
        follow_ups: [],
        issues: [],
      },
    };
    change.security_review = { run_id: 'rev1', status: 'completed', verdict: 'block' };
    setup({ graph: hiringGraph('done'), run: change, events: hiringEvents('done') });
    expect(await screen.findByText('Security Engineer blocked this change.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'See what blocks' })).toHaveAttribute('href', '/workspace/rev1');
    // The change itself at first glance: its files, and a check that failed is not hidden.
    expect(screen.getByText('2 files changed')).toBeInTheDocument();
    expect(screen.getByText('app/export.py, tests/test_export.py')).toBeInTheDocument();
    expect(screen.getByText('Did not pass')).toBeInTheDocument();
    expect(screen.getByText('3 failed (pytest)')).toBeInTheDocument();
  });

  it('says a review of the change is at work before it has decided', async () => {
    const change = hiringRun('done');
    change.security_review = { run_id: null, status: 'starting', verdict: null };
    setup({ graph: hiringGraph('done'), run: change, events: hiringEvents('done') });
    expect(await screen.findByText('Security Engineer is reviewing this change…')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /review|blocks/ })).not.toBeInTheDocument();
  });

  it('says so when the review found nothing that blocks', async () => {
    const passed = hiringRun('done');
    passed.security_review = { run_id: 'rev2', status: 'completed', verdict: 'pass' };
    setup({ graph: hiringGraph('done'), run: passed, events: hiringEvents('done') });
    expect(await screen.findByText('Security Engineer reviewed this change: nothing blocks.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open the review' })).toHaveAttribute('href', '/workspace/rev2');
  });

  it('shows no fix button under an ordinary result', async () => {
    setup({ graph: hiringGraph('done'), run: hiringRun('done'), events: hiringEvents('done') });
    await screen.findByRole('form', { name: 'Continue this task' });
    expect(screen.queryByRole('button', { name: 'Fix what blocks' })).not.toBeInTheDocument();
  });

  it('offers no "What next?" box while the task is still running', async () => {
    setup();
    await screen.findByRole('heading', { name: REQUEST });
    expect(screen.queryByRole('form', { name: 'Continue this task' })).not.toBeInTheDocument();
  });
});
