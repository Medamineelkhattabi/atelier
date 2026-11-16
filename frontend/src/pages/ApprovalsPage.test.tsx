import { beforeEach, describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Approval } from '../api/types';
import { PROJECT_STORAGE_KEY, ProjectProvider } from '../features/projects/ProjectContext';
import { AGENTS, approval, project } from '../features/work/testFixtures';
import { mockFetch, renderWithProviders, type RecordedCall } from '../test/utils';
import { ApprovalsPage } from './ApprovalsPage';

function setup(pending: Approval[], decided: Approval[] = []) {
  const fetch = mockFetch({
    'GET /api/projects': { items: [project('alpha', 'Alpha'), project('beta', 'Beta')] },
    'GET /api/agents': { items: AGENTS, load_errors: {} },
    'GET /api/approvals': (call: RecordedCall) => ({ body: { items: call.query.status === 'pending' ? pending : [...pending, ...decided] } }),
  });
  renderWithProviders(
    <ProjectProvider>
      <ApprovalsPage />
    </ProjectProvider>,
    { route: '/approvals' },
  );
  return fetch;
}

beforeEach(() => window.localStorage.clear());

describe('Approvals', () => {
  it('lists requests waiting for you in plain words, with the task, its project and a link to open it', async () => {
    setup([approval('ap1', { project_id: 'alpha' })]);
    const list = await screen.findByRole('list', { name: 'Requests waiting for you' });
    expect(within(list).getByText('Researcher wants to read the web page https://example.org/prices.')).toBeInTheDocument();
    expect(within(list).getByText(/This contacts example.org/)).toBeInTheDocument();
    expect(within(list).getByText('Check the current prices')).toBeInTheDocument();
    expect(within(list).getByText('“Compare tools”')).toBeInTheDocument();
    await within(list).findByText('· Project Alpha');
    expect(within(list).getByRole('link', { name: 'Open the task' })).toHaveAttribute('href', '/workspace/run-root');
    expect(within(list).getByRole('button', { name: 'Approve' })).toBeEnabled();
    expect(within(list).queryByText('web_fetch')).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Waiting for you/ })).toHaveAttribute('aria-selected', 'true');
  });

  it('explains when approvals appear when nothing is waiting', async () => {
    setup([]);
    expect(await screen.findByText('Nothing is waiting for you')).toBeInTheDocument();
    expect(screen.getByText('Sensitive actions ask here first.')).toBeInTheDocument();
  });

  it('follows the selected project and counts what is elsewhere instead of hiding it', async () => {
    window.localStorage.setItem(PROJECT_STORAGE_KEY, 'beta');
    setup([approval('ap1', { project_id: 'alpha' }), approval('ap2', { project_id: 'beta', agent_id: 'planning' })]);
    expect(await screen.findByText(/^Planner wants to/)).toBeInTheDocument();
    expect(screen.queryByText(/^Researcher wants to/)).not.toBeInTheDocument();
    expect(screen.getByText('1 more request waiting in other projects or outside any project')).toBeInTheDocument();
    await userEvent.click(screen.getAllByRole('button', { name: 'Show all projects' })[0]!);
    expect(await screen.findByText(/^Researcher wants to/)).toBeInTheDocument();
  });

  it('shows decisions made earlier, with what each one meant', async () => {
    setup([], [approval('ap3', { status: 'expired', decided_at: '2026-11-11T10:10:00+00:00' }), approval('ap4', { status: 'approved', note: 'ok', decided_at: '2026-11-11T10:10:00+00:00' })]);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: 'Decided earlier' }));
    const list = await screen.findByRole('list', { name: 'Decided earlier' });
    expect(within(list).getByText('Expired')).toBeInTheDocument();
    expect(within(list).getByText(/Nobody answered in time, so it was not done/)).toBeInTheDocument();
    expect(within(list).getByText('Approved')).toBeInTheDocument();
    expect(within(list).queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
  });
});
