import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import type { Agent, AgentPatch } from '../api/types';
import { ToastProvider } from '../components/toast';
import { ENGINES, TEAM, runFor, toolInfo } from '../features/team/fixtures';
import { mockFetch, renderWithProviders, type RecordedCall } from '../test/utils';
import { TeamMemberPage } from './TeamMemberPage';

const RESEARCHER = TEAM.find((a) => a.id === 'research')!;
const ENGINEER = TEAM.find((a) => a.id === 'software-engineering')!;
const COORDINATOR = TEAM.find((a) => a.id === 'orchestrator')!;

function setup(agent: Agent = RESEARCHER, routes: Record<string, unknown> = {}) {
  let current = agent;
  const fetch = mockFetch({
    [`GET /api/agents/${agent.id}`]: () => ({ body: { agent: current, recent_runs: [], toml: '' } }),
    [`PATCH /api/agents/${agent.id}`]: (call: RecordedCall) => {
      const patch = call.body as AgentPatch;
      if (patch.enabled !== undefined) current = { ...current, enabled: patch.enabled };
      if (patch.overrides?.provider) {
        const provider = patch.overrides.provider;
        current = { ...current, provider, effective_provider: provider === 'default' ? 'claude-code' : provider, overrides: { ...current.overrides, provider } };
      }
      return { body: { agent: current, recent_runs: [], toml: '' } };
    },
    'GET /api/agents': { items: TEAM, load_errors: {} },
    'GET /api/engines': { items: ENGINES },
    'GET /api/tools': { items: [toolInfo('web_fetch')] },
    'GET /api/runs': {
      total: 2,
      items: [
        runFor('child1', 'Find the latest release notes of FastAPI', { parent_run_id: 'root1', root_run_id: 'root1' }),
        runFor('solo1', 'Compare two logging libraries\n\n## Results handed off\n{...}', { status: 'failed' }),
      ],
    },
    ...routes,
  });
  renderWithProviders(
    <ToastProvider>
      <Routes>
        <Route path="/team/:agentId" element={<TeamMemberPage />} />
      </Routes>
    </ToastProvider>,
    { route: `/team/${agent.id}` },
  );
  return { ...fetch, user: userEvent.setup() };
}

describe('Team member profile', () => {
  it('describes what it does, what it will not do, what it can touch and what it gives back', async () => {
    setup();
    expect(await screen.findByRole('heading', { level: 1, name: 'Researcher' })).toBeInTheDocument();
    expect(screen.getByText('You need facts with sources before deciding something')).toBeInTheDocument();
    expect(within(screen.getByRole('list', { name: 'What it will not do' })).getByText(/it only reads/)).toBeInTheDocument();

    const abilities = screen.getByRole('list', { name: 'What Researcher can do' });
    expect(within(abilities).getByText('Reads web pages').closest('li')).toHaveTextContent('Asks you first');
    expect(screen.getByRole('link', { name: 'Approvals' })).toHaveAttribute('href', '/approvals');
    expect(screen.getByRole('link', { name: 'Change the rules' })).toHaveAttribute('href', '/tools');
    expect(screen.getByText('Useful when')).toBeInTheDocument();

    const back = screen.getByRole('list', { name: 'What you get back' });
    expect(within(back).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'A short summary',
      'Findings, each with its sources',
      'The list of sources it read',
      'Open questions that still need an answer',
    ]);
    expect(screen.getByText(/fully done, partly done or could not be done/)).toBeInTheDocument();

    const worksWith = screen.getByRole('list', { name: 'Works with' });
    expect(within(worksWith).getByRole('link', { name: /Coordinator/ })).toHaveAttribute('href', '/team/orchestrator');
  });

  it('applies the owner’s rules from Tools & Connections', async () => {
    setup(RESEARCHER, { 'GET /api/tools': { items: [toolInfo('web_fetch', { global_permission: 'deny' })] } });
    const abilities = await screen.findByRole('list', { name: 'What Researcher can do' });
    expect(within(abilities).getByText('Reads web pages').closest('li')).toHaveTextContent('Blocked by you');
  });

  it('offers the main action and the advanced settings, and keeps technical details out of the way', async () => {
    const { user } = setup();
    expect(await screen.findByRole('link', { name: 'Ask Researcher' })).toHaveAttribute('href', '/?agent=research');
    expect(screen.getByRole('link', { name: /Advanced settings/ })).toHaveAttribute('href', '/team/research/settings');
    expect(screen.queryByText('research')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Technical details' }));
    expect(screen.getByText('research')).toBeInTheDocument();
    expect(screen.getByText('claude-sonnet')).toBeInTheDocument();
  });

  it('lists its recent work in plain words, linking to the whole task', async () => {
    const { calls } = setup();
    const list = await screen.findByRole('list', { name: 'Recent work of Researcher' });
    const links = within(list).getAllByRole('link');
    expect(links[0]).toHaveAttribute('href', '/workspace/root1');
    expect(links[0]).toHaveTextContent('Part of a bigger task');
    expect(links[0]).toHaveTextContent('Done');
    expect(links[1]).toHaveAttribute('href', '/workspace/solo1');
    expect(links[1]).toHaveTextContent('Compare two logging libraries');
    expect(links[1]).not.toHaveTextContent('Results handed off');
    expect(links[1]).toHaveTextContent("Couldn't finish");
    expect(calls.find((c) => c.path === '/api/runs')?.query).toMatchObject({ agent_id: 'research' });
  });

  it('turns the team member off and on, and explains what that means', async () => {
    const { user, calls } = setup();
    expect(await screen.findByText(/When off, nobody can give it work/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Turn off Researcher' }));
    expect(await screen.findByRole('heading', { name: 'Off: it cannot be given work' })).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ enabled: false });
    expect(screen.getByText('Turned off')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ask Researcher' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Turn on Researcher' }));
    expect(await screen.findByRole('heading', { name: 'On: it can be given work' })).toBeInTheDocument();
  });

  it('lets the owner choose the agent it runs on: Claude Code first, agents not installed disabled', async () => {
    const { user, calls } = setup(ENGINEER);
    const select = await screen.findByRole('combobox', { name: 'Runs on' });
    const options = within(select).getAllByRole('option') as HTMLOptionElement[];
    expect(options.map((o) => [o.textContent, o.value, o.disabled])).toEqual([
      ['Claude Code', 'default', false],
      ['Gemini CLI', 'acp:gemini', false],
      ['Codex (not installed)', 'acp:codex', true],
    ]);
    expect(select).toHaveValue('default');
    expect(screen.getByText('Runs on your Claude plan.')).toBeInTheDocument();

    await user.selectOptions(select, 'acp:gemini');
    expect(await screen.findByText('Gemini CLI now runs Software Engineer')).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ overrides: { provider: 'acp:gemini' } });
    expect(screen.getByRole('combobox', { name: 'Runs on' })).toHaveValue('acp:gemini');
    const note = screen.getByText(/Runs on your Google account\./);
    expect(note).toHaveTextContent('Runs on your Google account. Sign in once: Run gemini once and choose Sign in with Google');
    expect(within(note).getByText('gemini')).toBeInTheDocument();

    await user.selectOptions(screen.getByRole('combobox', { name: 'Runs on' }), 'default');
    expect(await screen.findByText('Claude Code now runs Software Engineer')).toBeInTheDocument();
    expect(calls.filter((c) => c.method === 'PATCH').at(-1)?.body).toEqual({ overrides: { provider: 'default' } });
  });

  it('keeps the Coordinator on Claude Code and says why', async () => {
    const { calls } = setup(COORDINATOR);
    expect(await screen.findByText('The Coordinator plans with tools only Claude Code can use today.')).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Runs on' })).not.toBeInTheDocument();
    expect(screen.queryByText(/Gemini CLI/)).not.toBeInTheDocument();
    expect(calls.some((c) => c.path === '/api/engines')).toBe(false);
  });

  it('offers no choice of agent for a team member that works behind the scenes', async () => {
    setup(TEAM.find((a) => a.id === 'evaluator')!);
    expect(await screen.findByText('Behind the scenes')).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Runs on' })).not.toBeInTheDocument();
  });

  it('says what is wrong when a team member needs fixing', async () => {
    setup({ ...RESEARCHER, status: 'misconfigured', problems: ["tool 'web_fetch' is not available"] });
    expect(await screen.findByText('Needs fixing')).toBeInTheDocument();
    expect(screen.getByText("tool 'web_fetch' is not available")).toBeInTheDocument();
  });

  it('explains a missing team member instead of a raw error', async () => {
    mockFetch({
      'GET /api/agents/ghost': { status: 404, body: { detail: 'agent not found' } },
      'GET /api/agents': { items: TEAM, load_errors: {} },
      'GET /api/tools': { items: [] },
    });
    renderWithProviders(
      <Routes>
        <Route path="/team/:agentId" element={<TeamMemberPage />} />
      </Routes>,
      { route: '/team/ghost' },
    );
    expect(await screen.findByText('This team member does not exist')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'See my AI team' })).toHaveAttribute('href', '/team');
  });
});
