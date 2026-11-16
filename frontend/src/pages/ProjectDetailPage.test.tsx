import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import type { Project } from '../api/types';
import { ProjectProvider } from '../features/projects/ProjectContext';
import { mockFetch, renderWithProviders, type RecordedCall } from '../test/utils';
import { ProjectDetailPage } from './ProjectDetailPage';

const PROJECT: Project = {
  id: 'site',
  name: 'Website',
  description: '',
  workspace: 'C:\\data\\workspaces\\site',
  context: 'A static site.',
  tags: [],
  trust_edits: false,
  archived: false,
  created_at: '2026-11-01T10:00:00+00:00',
  updated_at: '2026-11-01T10:00:00+00:00',
  stats: { runs: 0, active: 0, last_run_at: null },
};

function setup(route = '/projects/site', project: Project = PROJECT) {
  let current = project;
  const fetch = mockFetch({
    'GET /api/projects/site': () => ({ body: current }),
    'PATCH /api/projects/site': (call: RecordedCall) => {
      current = { ...current, ...(call.body as Partial<Project>) };
      return { body: current };
    },
    'GET /api/projects': () => ({ body: { items: [current] } }),
    'GET /api/runs': { total: 0, items: [] },
    'GET /api/agents': { items: [], load_errors: {} },
  });
  renderWithProviders(
    <ProjectProvider>
      <Routes>
        <Route path="/projects/:projectId" element={<ProjectDetailPage />} />
      </Routes>
    </ProjectProvider>,
    { route },
  );
  return { ...fetch, user: userEvent.setup() };
}

describe('Project page', () => {
  it('lets file edits run without asking in this project, in one switch', async () => {
    const { calls, user } = setup();
    const trust = await screen.findByRole('switch', { name: 'Work without asking' });
    expect(trust).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByText('File edits, reading and tests. Anything else still asks.')).toBeInTheDocument();
    await user.click(trust);
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ trust_edits: true });
    expect(await screen.findByRole('switch', { name: 'Work without asking' })).toHaveAttribute('aria-checked', 'true');
  });

  it('offers to watch the app only when the folder has one, in one switch', async () => {
    const { calls, user } = setup('/projects/site', { ...PROJECT, watch: { on: false, available: true } });
    const watch = await screen.findByRole('switch', { name: 'Watch the app' });
    expect(watch).toHaveAttribute('aria-checked', 'false');
    await user.click(watch);
    await waitFor(() => expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ watch: { on: true } }));
  });

  it('shows no watch switch for a folder without an app', async () => {
    setup('/projects/site', { ...PROJECT, watch: { on: false, available: false } });
    await screen.findByRole('switch', { name: 'Work without asking' });
    expect(screen.queryByRole('switch', { name: 'Watch the app' })).not.toBeInTheDocument();
  });

  it('says when the team also uses the Claude Code memory of the folder', async () => {
    setup('/projects/site', { ...PROJECT, claude_memory: { notes: 131, folder: 'C:\\Users\\me\\.claude\\projects\\x\\memory' } });
    expect(await screen.findByText('Your team also uses your Claude Code memory for this folder (131 notes).')).toBeInTheDocument();
  });

  it('keeps only what matters: no description, labels, starter files or Claude Code set-up', async () => {
    const { user } = setup('/projects/site?tab=advanced');
    expect(await screen.findByRole('heading', { name: 'Project folder' })).toBeInTheDocument();
    expect(screen.queryByText(/Starter files/)).not.toBeInTheDocument();
    expect(screen.queryByText(/\.mcp\.json|Claude Code/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Overview' }));
    expect(screen.queryByText('Labels')).not.toBeInTheDocument();
    expect(screen.queryByText('Description')).not.toBeInTheDocument();
  });
});
