import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { RunSummary } from '../api/types';
import { ProjectProvider } from '../features/projects/ProjectContext';
import { AGENTS, project, run } from '../features/work/testFixtures';
import { mockFetch, renderWithProviders, type RecordedCall } from '../test/utils';
import { MyWorkPage } from './MyWorkPage';

function many(count: number): RunSummary[] {
  return Array.from({ length: count }, (_, i) => run(`m${i}`, `Task number ${i}`));
}

function setup(items: RunSummary[], route = '/work') {
  const fetch = mockFetch({
    'GET /api/projects': { items: [project('alpha', 'Alpha')] },
    'GET /api/agents': { items: AGENTS, load_errors: {} },
    'GET /api/runs': (call: RecordedCall) => {
      const limit = Number(call.query.limit ?? 50);
      return { body: { total: items.length, items: items.slice(0, limit) } };
    },
    'DELETE /api/runs/r1': { deleted: 'r1' },
  });
  renderWithProviders(
    <ProjectProvider>
      <MyWorkPage />
    </ProjectProvider>,
    { route },
  );
  return fetch;
}

const runCalls = (calls: RecordedCall[]) => calls.filter((c) => c.method === 'GET' && c.path === '/api/runs');

beforeEach(() => window.localStorage.clear());

describe('My Work', () => {
  it('lists each task in plain words: text, status, team member, project, when and how long', async () => {
    setup([
      run('r1', 'Compare tools\n\n## Results handed off\nsecret context', { project_id: 'alpha' }),
      run('r2', 'Plan the move', { status: 'running', agent_id: 'planning', finished_at: null, duration_s: null }),
      run('r3', 'Team job', { kind: 'team', agent_id: null, team_name: 'Writers', status: 'failed' }),
      run('r4', 'Scripted check', { provider: 'scripted', follow_up_of: 'r1' }),
    ]);
    const link = await screen.findByRole('link', { name: 'Compare tools' });
    expect(link).toHaveAttribute('href', '/workspace/r1');
    expect(screen.queryByText(/secret context/)).not.toBeInTheDocument();
    const first = link.closest('li')!;
    expect(within(first).getByText('Researcher')).toBeInTheDocument();
    expect(within(first).getByText('Alpha')).toBeInTheDocument();
    expect(within(first).getByText('Done')).toBeInTheDocument();
    expect(within(first).getByText('took 2m 05s')).toBeInTheDocument();

    const active = screen.getByRole('link', { name: 'Plan the move' }).closest('li')!;
    expect(within(active).getByText('Planner')).toBeInTheDocument();
    expect(within(active).getByText('Working')).toBeInTheDocument();
    expect(within(active).queryByRole('button', { name: /Delete/ })).not.toBeInTheDocument();

    const team = screen.getByRole('link', { name: 'Team job' }).closest('li')!;
    expect(within(team).getByText('Team “Writers”')).toBeInTheDocument();
    expect(within(team).getByText("Couldn't finish")).toBeInTheDocument();
    expect(within(team).getByRole('link', { name: 'Start again' })).toHaveAttribute('href', '/?task=Team+job');

    const scripted = screen.getByRole('link', { name: 'Scripted check' }).closest('li')!;
    expect(within(scripted).getByText('Test mode')).toBeInTheDocument();
    expect(within(scripted).getByText('follow-up')).toBeInTheDocument();
    expect(within(first).queryByText('follow-up')).not.toBeInTheDocument();
    expect(screen.getByText('4 tasks')).toBeInTheDocument();
  });

  it('filters by status with chips, searches, and keeps both in the address bar', async () => {
    const { calls } = setup([run('r1', 'Compare tools')]);
    await screen.findByRole('link', { name: 'Compare tools' });
    const user = userEvent.setup();
    const chips = screen.getByRole('group', { name: 'Filter by status' });
    expect(within(chips).getAllByRole('button').map((b) => b.textContent)).toEqual(['All', 'In progress', 'Needs your approval', 'Done', "Couldn't finish", 'Stopped']);
    expect(within(chips).getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true');

    await user.click(within(chips).getByRole('button', { name: "Couldn't finish" }));
    await vi.waitFor(() => expect(runCalls(calls).at(-1)?.query.status).toBe('failed,interrupted'));
    expect(within(chips).getByRole('button', { name: "Couldn't finish" })).toHaveAttribute('aria-pressed', 'true');

    await user.type(screen.getByLabelText('Search my work'), 'tools');
    await vi.waitFor(() => expect(runCalls(calls).at(-1)?.query).toMatchObject({ q: 'tools', status: 'failed,interrupted', root_only: 'true' }));
  });

  it('shows more on demand', async () => {
    const { calls } = setup(many(25));
    expect(await screen.findByText('25 tasks, showing the newest 20')).toBeInTheDocument();
    expect(runCalls(calls)[0]?.query.limit).toBe('20');
    await userEvent.click(screen.getByRole('button', { name: 'Show more' }));
    await vi.waitFor(() => expect(screen.getAllByRole('link', { name: /^Task number/ })).toHaveLength(25));
    expect(runCalls(calls).at(-1)?.query.limit).toBe('40');
    expect(screen.queryByRole('button', { name: 'Show more' })).not.toBeInTheDocument();
  });

  it('deletes a finished task only after confirmation', async () => {
    const { calls } = setup([run('r1', 'Compare tools')]);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Delete the task “Compare tools”' }));
    const dialog = screen.getByRole('dialog', { name: 'Delete this task?' });
    expect(within(dialog).getByText(/This cannot be undone/)).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    await user.click(within(dialog).getByRole('button', { name: 'Delete permanently' }));
    await vi.waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.path === '/api/runs/r1')).toBe(true));
  });

  it('has helpful empty states', async () => {
    setup([]);
    expect(await screen.findByText('Nothing yet')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Start on Home' })).toHaveAttribute('href', '/');
  });

  it('offers to clear filters when nothing matches', async () => {
    setup([], '/work?status=done&q=zzz');
    expect(await screen.findByText('No task matches')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Clear the search and filters' }));
    expect(await screen.findByText('Nothing yet')).toBeInTheDocument();
    expect(screen.getByLabelText('Search my work')).toHaveValue('');
  });
});
