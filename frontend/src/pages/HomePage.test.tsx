import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes, useParams } from 'react-router-dom';
import type { Agent, Approval, Project, ProviderStatus, RunSummary } from '../api/types';
import { PROJECT_STORAGE_KEY, ProjectProvider } from '../features/projects/ProjectContext';
import { HOW_IT_WORKS_KEY } from '../features/onboarding/HowItWorks';
import { AGENTS, SCRIPTED, SIGNED_OUT, approval, claudeProvider, project, run } from '../features/work/testFixtures';
import { mockFetch, renderWithProviders, type RecordedCall } from '../test/utils';
import { HomePage } from './HomePage';

function Workspace() {
  const { runId } = useParams();
  return <p>Workspace of {runId}</p>;
}

interface Options {
  route?: string;
  providers?: ProviderStatus[];
  runs?: Record<string, RunSummary[]>;
  approvals?: Approval[];
  createRun?: unknown;
  agents?: Agent[];
  projects?: Project[];
}

function setup({
  route = '/',
  providers = [claudeProvider(), SCRIPTED],
  runs = {},
  approvals = [],
  createRun = { run_id: 'new-run' },
  agents = AGENTS,
  projects = [project('alpha', 'Alpha')],
}: Options = {}) {
  const fetch = mockFetch({
    'GET /api/providers': { items: providers },
    'GET /api/agents': { items: agents, load_errors: {} },
    'GET /api/projects': () => ({ body: { items: projects } }),
    'POST /api/projects': (call: RecordedCall) => {
      const created = project('kitchen', (call.body as { name: string }).name);
      projects.push(created);
      return { body: created };
    },
    'GET /api/approvals': { items: approvals },
    'GET /api/runs': (call: RecordedCall) => {
      const items = runs[call.query.status ?? ''] ?? [];
      return { body: { total: items.length, items } };
    },
    'POST /api/runs': createRun,
    'POST /api/runs/r9/resume': { status: 'running' },
    'POST /api/approvals/ap1/decision': { id: 'ap1', status: 'approved' },
  });
  renderWithProviders(
    <ProjectProvider>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/workspace/:runId" element={<Workspace />} />
      </Routes>
    </ProjectProvider>,
    { route },
  );
  return fetch;
}

const posts = (calls: RecordedCall[], path: string) => calls.filter((c) => c.method === 'POST' && c.path === path);

async function startButton() {
  const button = await screen.findByRole('button', { name: 'Start' });
  await vi.waitFor(() => expect(button).toBeEnabled());
  return button;
}

beforeEach(() => window.localStorage.clear());

describe('Home', () => {
  it('prefills from the address bar and starts with that team member and project, without provider or options', async () => {
    const { calls } = setup({ route: '/?task=Find%20the%20best%20prices&agent=research&project=alpha' });
    expect(screen.getByLabelText('What would you like to accomplish?')).toHaveValue('Find the best prices');
    expect(await screen.findByText('Researcher')).toBeInTheDocument();
    expect(screen.getByText(/works on it\./)).toBeInTheDocument();
    await vi.waitFor(() => expect(screen.getByLabelText('Which project is this for?')).toHaveValue('alpha'));

    await userEvent.click(await startButton());
    expect(await screen.findByText('Workspace of new-run')).toBeInTheDocument();
    expect(posts(calls, '/api/runs')[0]?.body).toEqual({ task: 'Find the best prices', agent_id: 'research', project_id: 'alpha' });
  });

  it('a suggestion fills the box, selects the first [bracket] and says who will do it', async () => {
    const { calls } = setup();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /Plan a project/ }));
    const box = screen.getByLabelText('What would you like to accomplish?') as HTMLTextAreaElement;
    expect(box.value).toBe('Break down [your goal] into clear steps, with the risks and the open questions.');
    expect(box).toHaveFocus();
    expect(box.value.slice(box.selectionStart, box.selectionEnd)).toBe('[your goal]');
    expect(screen.getByText('Planner')).toBeInTheDocument();

    // The placeholder must be replaced before starting.
    await user.click(await startButton());
    expect(screen.getByRole('alert')).toHaveTextContent('Replace [your goal] with your own words first.');
    expect(posts(calls, '/api/runs')).toHaveLength(0);

    await user.clear(box);
    await user.type(box, 'Break down my house move into clear steps.');
    await user.click(screen.getByRole('button', { name: 'Start' }));
    await screen.findByText('Workspace of new-run');
    expect(posts(calls, '/api/runs')[0]?.body).toEqual({ task: 'Break down my house move into clear steps.', agent_id: 'planning' });
  });

  it('lets the Coordinator decide by default, and Change offers team members by name', async () => {
    const { calls } = setup();
    const user = userEvent.setup();
    expect(await screen.findByText('picks the right specialists.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Change' }));
    const picker = screen.getByLabelText('Who should work on it?');
    const options = within(picker).getAllByRole('option').map((o) => o.textContent);
    expect(options).toEqual(['Let the Coordinator decide (recommended)', 'Planner', 'Researcher']);
    await user.selectOptions(picker, 'research');
    await user.selectOptions(picker, '');
    await user.click(screen.getByRole('button', { name: 'Done' }));

    await user.type(screen.getByLabelText('What would you like to accomplish?'), 'Organise my week');
    await user.click(await startButton());
    await screen.findByText('Workspace of new-run');
    expect(posts(calls, '/api/runs')[0]?.body).toEqual({ task: 'Organise my week', agent_id: 'orchestrator' });
  });

  it('in a code project the Software Engineer takes the request directly; the Coordinator stays one choice away', async () => {
    const engineer: Agent = { ...AGENTS[1]!, id: 'software-engineering', name: 'Software Engineer' };
    const shop: Project = { ...project('shop', 'Shop'), direct_member: 'software-engineering' };
    const { calls } = setup({ route: '/?project=shop', agents: [...AGENTS, engineer], projects: [shop, project('alpha', 'Alpha')] });
    const user = userEvent.setup();
    expect(await screen.findByText('works on it directly, like Claude Code.')).toBeInTheDocument();
    expect(screen.getByText('Software Engineer')).toBeInTheDocument();

    await user.type(screen.getByLabelText('What would you like to accomplish?'), 'Fix the status page');
    await user.click(await startButton());
    await screen.findByText('Workspace of new-run');
    expect(posts(calls, '/api/runs')[0]?.body).toEqual({ task: 'Fix the status page', agent_id: 'software-engineering', project_id: 'shop' });
  });

  it('the Coordinator can still be chosen in a code project, and decides in the other projects', async () => {
    const engineer: Agent = { ...AGENTS[1]!, id: 'software-engineering', name: 'Software Engineer' };
    const shop: Project = { ...project('shop', 'Shop'), direct_member: 'software-engineering' };
    const { calls } = setup({ route: '/?project=shop', agents: [...AGENTS, engineer], projects: [shop, project('alpha', 'Alpha')] });
    const user = userEvent.setup();
    await screen.findByText('works on it directly, like Claude Code.');
    await user.click(screen.getByRole('button', { name: 'Change' }));
    const picker = screen.getByLabelText('Who should work on it?');
    const options = within(picker).getAllByRole('option').map((o) => o.textContent);
    expect(options).toEqual(['Let the Coordinator split it among the team', 'Planner', 'Researcher', 'Software Engineer (recommended: direct, fastest)']);
    await user.selectOptions(picker, '');
    expect(screen.getByText('picks the right specialists.')).toBeInTheDocument();
    await user.type(screen.getByLabelText('What would you like to accomplish?'), 'Research and build');
    await user.click(await startButton());
    await screen.findByText('Workspace of new-run');
    expect(posts(calls, '/api/runs')[0]?.body).toEqual({ task: 'Research and build', agent_id: 'orchestrator', project_id: 'shop' });
  });

  it('a code project whose Software Engineer is switched off goes to the Coordinator, without a warning', async () => {
    const off: Agent = { ...AGENTS[1]!, id: 'software-engineering', name: 'Software Engineer', enabled: false, status: 'disabled' };
    const shop: Project = { ...project('shop', 'Shop'), direct_member: 'software-engineering' };
    setup({ route: '/?project=shop', agents: [...AGENTS, off], projects: [shop] });
    expect(await screen.findByText('picks the right specialists.')).toBeInTheDocument();
    await vi.waitFor(() => expect(screen.getByLabelText('Which project is this for?')).toHaveValue('shop'));
    expect(screen.queryByText(/is off or gone/)).not.toBeInTheDocument();
  });

  it('asks to connect the Claude subscription first, and explains why Start is disabled', async () => {
    setup({ providers: [SIGNED_OUT, SCRIPTED] });
    expect(await screen.findByRole('heading', { name: 'Connect your Claude subscription' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start' })).toBeDisabled();
    expect(screen.getByText('Connect your Claude subscription first (see below).')).toBeInTheDocument();
  });

  it('says honestly when answers come from the test script', async () => {
    // Team members set to "default" then resolve to the scripted provider.
    setup({
      providers: [claudeProvider({ is_default: false }), { ...SCRIPTED, is_default: true }],
      agents: AGENTS.map((a) => ({ ...a, effective_provider: 'scripted' })),
    });
    expect(await screen.findByText('Test mode: answers come from a script, not an AI model.')).toBeInTheDocument();
    expect(await startButton()).toBeEnabled();
  });

  it('shows a refusal in plain words and stays on Home', async () => {
    setup({ createRun: { status: 400, body: { detail: "agent 'orchestrator' is disabled" } } });
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('What would you like to accomplish?'), 'Do something');
    await user.click(await startButton());
    expect(await screen.findByText("agent 'orchestrator' is disabled")).toBeInTheDocument();
    expect(screen.getByText(/Your task could not start/)).toBeInTheDocument();
    expect(screen.queryByText(/Workspace of/)).not.toBeInTheDocument();
  });

  it('creates a new project inline and makes it the selected project', async () => {
    const { calls } = setup();
    const user = userEvent.setup();
    const choice = screen.getByLabelText('Which project is this for?');
    await within(choice).findByRole('option', { name: 'Alpha' });
    await user.selectOptions(choice, 'New project…');
    await user.type(screen.getByLabelText(/Project name/), 'Kitchen');
    await user.type(screen.getByLabelText('Notes for your team (optional)'), 'Budget 5000');
    await user.click(screen.getByRole('button', { name: 'Create project' }));
    await vi.waitFor(() => expect(choice).toHaveValue('kitchen'));
    expect(posts(calls, '/api/projects')[0]?.body).toEqual({ name: 'Kitchen', context: 'Budget 5000' });
    expect(window.localStorage.getItem(PROJECT_STORAGE_KEY)).toBe('kitchen');
    expect(screen.queryByLabelText(/Project name/)).not.toBeInTheDocument();
  });

  it('lists what needs attention in plain words: approvals to decide and interrupted tasks to continue', async () => {
    const { calls } = setup({
      approvals: [
        approval('ap1'),
        approval('ap2', { tool: 'shell_run', args: { command: 'rm -rf build' }, agent_id: 'planning', run_task: 'Clean up' }),
      ],
      runs: { interrupted: [run('r9', 'Write the report', { status: 'interrupted' })] },
    });
    const user = userEvent.setup();
    const list = await screen.findByRole('list', { name: 'Things that need your attention' });
    expect(within(list).getByText('Researcher wants to read the web page https://example.org/prices.')).toBeInTheDocument();
    expect(within(list).getByText(/For your task “Compare tools”/)).toBeInTheDocument();
    // A command must be read first: only "Review" for it.
    expect(within(list).getByText('Planner wants to run a command in the project folder.')).toBeInTheDocument();
    expect(within(list).getAllByRole('button', { name: /^Approve/ })).toHaveLength(1);
    expect(within(list).getAllByRole('link', { name: 'Review' }).map((l) => l.getAttribute('href'))).toEqual(['/approvals#approval-ap1', '/approvals#approval-ap2']);

    await user.click(within(list).getByRole('button', { name: /^Approve/ }));
    await vi.waitFor(() => expect(posts(calls, '/api/approvals/ap1/decision')[0]?.body).toEqual({ approve: true }));

    expect(within(list).getByRole('link', { name: 'Write the report' })).toHaveAttribute('href', '/workspace/r9');
    expect(within(list).getByText('Interrupted')).toBeInTheDocument();
    await user.click(within(list).getByRole('button', { name: 'Continue' }));
    await vi.waitFor(() => expect(posts(calls, '/api/runs/r9/resume')).toHaveLength(1));
  });

  it('shows tasks in progress and recent work in plain words, each opening the task', async () => {
    setup({
      runs: {
        'queued,running,waiting_approval': [run('r2', 'Draft the plan', { status: 'running', agent_id: 'planning', finished_at: null, duration_s: null })],
        'completed,failed,cancelled': [run('r1', 'Compare tools\n\n## Input\n{"a": 1}', { project_id: 'alpha' }), run('r0', 'Old one', { status: 'failed' })],
      },
    });
    const active = await screen.findByRole('link', { name: 'Draft the plan' });
    expect(active).toHaveAttribute('href', '/workspace/r2');
    expect(screen.getByText('Working')).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: 'Compare tools' })).toHaveAttribute('href', '/workspace/r1');
    expect(screen.getByText('Done')).toBeInTheDocument();
    expect(screen.getByText("Couldn't finish")).toBeInTheDocument();
    expect(screen.getAllByText('took 2m 05s')).toHaveLength(2);
    expect(screen.getByRole('link', { name: /See all my work/ })).toHaveAttribute('href', '/work');
    expect(screen.getByText('Nothing needs you right now.')).toBeInTheDocument();
  });

  it('shows "How it works" as one line until it is hidden', async () => {
    setup();
    const user = userEvent.setup();
    expect(screen.getByRole('region', { name: 'How it works' })).toHaveTextContent('asks you before anything sensitive');
    await user.click(screen.getByRole('button', { name: 'Hide “How it works”' }));
    expect(screen.queryByRole('region', { name: 'How it works' })).not.toBeInTheDocument();
    expect(window.localStorage.getItem(HOW_IT_WORKS_KEY)).toBe('1');
  });
});
