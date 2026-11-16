import { beforeEach, describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Project, RunSummary } from '../../api/types';
import { MyWorkPage } from '../../pages/MyWorkPage';
import { splitByProject } from '../../pages/ApprovalsPage';
import { mockFetch, renderWithProviders, type RecordedCall } from '../../test/utils';
import { PROJECT_STORAGE_KEY, ProjectProvider, ProjectSwitcher } from './ProjectContext';

function project(id: string, name: string): Project {
  return {
    id,
    name,
    description: '',
    workspace: `C:\\data\\workspaces\\${id}`,
    context: '',
    tags: [],
    archived: false,
    created_at: '2026-11-01T10:00:00+00:00',
    updated_at: '2026-11-01T10:00:00+00:00',
    stats: { runs: 1, active: 0, last_run_at: null },
  };
}

function run(id: string, task: string, projectId: string | null): RunSummary {
  return {
    id,
    kind: 'agent',
    agent_id: 'research',
    team_id: null,
    parent_run_id: null,
    root_run_id: id,
    role: null,
    status: 'completed',
    task,
    provider: 'claude-code',
    model: null,
    agent_version: '1.0.0',
    steps: 1,
    tool_calls: 0,
    input_tokens: 10,
    output_tokens: 5,
    cost_usd: 0,
    error: null,
    created_at: '2026-11-11T10:00:00+00:00',
    started_at: '2026-11-11T10:00:00+00:00',
    finished_at: '2026-11-11T10:01:00+00:00',
    duration_s: 60,
    team_name: null,
    project_id: projectId,
  };
}

const RUNS = [run('r1', 'Alpha task', 'alpha'), run('r2', 'Beta task', 'beta'), run('r3', 'Loose task', null)];

function setup(route = '/history') {
  const fetch = mockFetch({
    'GET /api/projects': { items: [project('alpha', 'Alpha'), project('beta', 'Beta')] },
    'GET /api/agents': { items: [], load_errors: {} },
    'GET /api/runs': (call: RecordedCall) => {
      const items = call.query.project_id ? RUNS.filter((r) => r.project_id === call.query.project_id) : RUNS;
      return { body: { total: items.length, items } };
    },
  });
  renderWithProviders(
    <ProjectProvider>
      <ProjectSwitcher />
      <MyWorkPage />
    </ProjectProvider>,
    { route },
  );
  return fetch;
}

const runCalls = (calls: RecordedCall[]) => calls.filter((c) => c.path === '/api/runs');

beforeEach(() => window.localStorage.clear());

describe('project switcher', () => {
  it('filters History by the selected project, remembers the choice, and can show all again', async () => {
    const { calls } = setup();
    expect(await screen.findByRole('link', { name: 'Loose task' })).toBeInTheDocument();
    expect(runCalls(calls)[0]?.query.project_id).toBeUndefined();

    const user = userEvent.setup();
    const switcher = await screen.findByLabelText('Project:');
    expect(within(switcher).getByRole('option', { name: 'All projects' })).toBeInTheDocument();
    await within(switcher).findByRole('option', { name: 'Alpha' });
    await user.selectOptions(switcher, 'alpha');

    expect(await screen.findByRole('link', { name: 'Alpha task' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Beta task' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Loose task' })).not.toBeInTheDocument();
    expect(runCalls(calls).at(-1)?.query.project_id).toBe('alpha');
    expect(window.localStorage.getItem(PROJECT_STORAGE_KEY)).toBe('alpha');

    await user.click(screen.getByRole('button', { name: 'Show all projects' }));
    expect(await screen.findByRole('link', { name: 'Beta task' })).toBeInTheDocument();
    expect(switcher).toHaveValue('');
    expect(window.localStorage.getItem(PROJECT_STORAGE_KEY)).toBeNull();
  });

  it('takes the project from a ?project= deep link and from the remembered choice', async () => {
    const first = setup('/history?project=beta');
    expect(await screen.findByRole('link', { name: 'Beta task' })).toBeInTheDocument();
    expect(runCalls(first.calls)[0]?.query.project_id).toBe('beta');
    expect(window.localStorage.getItem(PROJECT_STORAGE_KEY)).toBe('beta');
  });

  it('uses the remembered project when the URL has none', async () => {
    window.localStorage.setItem(PROJECT_STORAGE_KEY, 'alpha');
    const { calls } = setup('/history');
    expect(await screen.findByRole('link', { name: 'Alpha task' })).toBeInTheDocument();
    expect(runCalls(calls)[0]?.query.project_id).toBe('alpha');
  });
});

describe('approvals filtered by project', () => {
  it('never hides approvals of other projects silently: it counts them', () => {
    const items = [{ project_id: 'alpha' }, { project_id: 'beta' }, { project_id: null }];
    expect(splitByProject(items, null)).toEqual({ shown: items, elsewhere: 0 });
    expect(splitByProject(items, 'alpha')).toEqual({ shown: [items[0]], elsewhere: 2 });
  });
});
