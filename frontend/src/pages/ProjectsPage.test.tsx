import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { mockFetch, renderWithProviders } from '../test/utils';
import { ProjectsPage } from './ProjectsPage';

describe('My Projects list', () => {
  const PROJECT = {
    id: 'site',
    name: 'Website',
    description: 'The public website.',
    workspace: 'C:\data\workspaces\site',
    context: '',
    tags: ['client'],
    archived: false,
    created_at: '2026-11-01T10:00:00+00:00',
    updated_at: '2026-11-01T10:00:00+00:00',
    stats: { runs: 2, active: 1, last_run_at: '2026-11-10T10:00:00+00:00' },
  };

  it('explains what a project is and offers to start a task in each one', async () => {
    mockFetch({ 'GET /api/projects': { items: [PROJECT] } });
    renderWithProviders(<ProjectsPage />, { route: '/projects' });
    expect(await screen.findByRole('link', { name: 'Website' })).toHaveAttribute('href', '/projects/site');
    expect(screen.getByText(/Work in one project never mixes with another/)).toBeInTheDocument();
    expect(screen.getByText('1 in progress')).toBeInTheDocument();
    expect(screen.getByText(/No notes for your team yet/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Write them' })).toHaveAttribute('href', '/projects/site?tab=notes');
    expect(screen.getByRole('link', { name: /Start a task here/ })).toHaveAttribute('href', '/?project=site');
    // The folder path is a technical detail: on the project's Advanced tab, not on the card.
    expect(screen.queryByText('C:\data\workspaces\site')).not.toBeInTheDocument();
  });
});
