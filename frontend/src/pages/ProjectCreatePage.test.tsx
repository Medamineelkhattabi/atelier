import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { parsePrivatePaths, validateName, validateWorkspace } from '../features/projects/projectForm';
import { mockFetch, renderWithProviders } from '../test/utils';
import { ProjectCreatePage } from './ProjectCreatePage';

const ROOT = 'C:\\data\\workspaces';
const EXISTING = {
  id: 'legacy',
  name: 'Legacy',
  description: '',
  workspace: `${ROOT}\\legacy`,
  context: '',
  tags: [],
  archived: true,
  created_at: '2026-11-01T10:00:00+00:00',
  updated_at: '2026-11-01T10:00:00+00:00',
  stats: { runs: 3, active: 0, last_run_at: null },
};

describe('project form rules', () => {
  it('validates names and workspace folders like the server does', () => {
    expect(validateName('')).toBe('Give the project a name.');
    expect(validateName(' a ')).toMatch(/2 to 120 characters/);
    expect(validateName('Demo')).toBeNull();
    expect(validateWorkspace('', [ROOT])).toBeNull();
    expect(validateWorkspace('demo', [ROOT])).toMatch(/absolute path/);
    expect(validateWorkspace(ROOT, [ROOT])).toMatch(/not this location/);
    expect(validateWorkspace('C:\\Shop\\application', [ROOT])).toBeNull();
    expect(validateWorkspace(`${ROOT}\\legacy\\sub`, [ROOT], [EXISTING])).toMatch(/Already used by project “Legacy”/);
    expect(parsePrivatePaths('backups/\n\n./logs\ncerts\\tls\nbackups')).toEqual(['backups', 'logs', 'certs/tls']);
    expect(validateWorkspace(`${ROOT}\\Demo-App`, [ROOT], [EXISTING])).toBeNull();
  });
});

describe('ProjectCreatePage', () => {
  function setup(createRoute?: unknown) {
    const fetch = mockFetch({
      'GET /api/workspaces': { default: `${ROOT}\\default`, roots: [{ root: ROOT, directories: [`${ROOT}\\legacy`] }] },
      'GET /api/projects': { items: [EXISTING] },
      'POST /api/projects': createRoute ?? ((call: { body: unknown }) => ({
        body: {
          ...EXISTING,
          id: 'demo-app',
          name: 'Demo app',
          archived: false,
          workspace: (call.body as { workspace: string }).workspace,
          stats: { runs: 0, active: 0, last_run_at: null },
        },
      })),
    });
    renderWithProviders(<ProjectCreatePage />);
    return { ...fetch, user: userEvent.setup() };
  }

  it('blocks each step until it is valid, then creates the project with the cleaned values', async () => {
    const { calls, user } = setup();
    const next = () => user.click(screen.getByRole('button', { name: /^Next/ }));

    await next();
    expect(screen.getByText('Give the project a name.')).toBeInTheDocument();
    expect(screen.getByLabelText(/^Name/)).toHaveAttribute('aria-invalid', 'true');

    await user.type(screen.getByLabelText(/^Name/), 'A');
    await next();
    expect(screen.getByText(/must be 2 to 120 characters/)).toBeInTheDocument();

    await user.clear(screen.getByLabelText(/^Name/));
    await user.type(screen.getByLabelText(/^Name/), 'Demo app');
    // Only the name: no description or labels to fill in.
    expect(screen.queryByLabelText(/^Labels/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/^Description/)).not.toBeInTheDocument();
    await next();

    // Folder step: an existing folder anywhere; an overlapping one is refused before anything is sent.
    expect(await screen.findByRole('heading', { name: 'Project folder' })).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: /A folder I already have/ }));
    await next();
    expect(await screen.findByText('Paste the folder’s address.')).toBeInTheDocument();
    await user.type(screen.getByLabelText(/^Folder address/), `${ROOT}\\legacy\\sub`);
    await next();
    expect(await screen.findByText(/Already used by project “Legacy”/)).toBeInTheDocument();
    await user.clear(screen.getByLabelText(/^Folder address/));
    await user.type(screen.getByLabelText(/^Folder address/), 'C:\\Shop\\application');
    await user.type(screen.getByLabelText(/^Private folders/), 'backups{Enter}logs/');
    await next();

    expect(screen.getByRole('heading', { name: 'Project notes for your team' })).toBeInTheDocument();
    await next();
    // Four steps: no "Starter files".
    expect(screen.getByRole('heading', { name: 'Check and create' })).toBeInTheDocument();
    expect(within(screen.getByRole('list', { name: 'Steps' })).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'About',
      'Folder',
      'Notes for your team',
      '4Check and create',
    ]);
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: 'Create the project' }));
    expect(await screen.findByRole('heading', { name: 'Project created' })).toBeInTheDocument();
    const post = calls.find((c) => c.method === 'POST' && c.path === '/api/projects');
    expect(post?.body).toEqual({
      name: 'Demo app',
      workspace: 'C:\\Shop\\application',
      private_paths: ['backups', 'logs'],
    });
    expect(screen.getByRole('button', { name: 'Start a task in this project' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open the project' })).toHaveAttribute('href', '/projects/demo-app');
  });

  it('shows the server refusal on the review step and offers to change the folder', async () => {
    const { user } = setup({ status: 409, body: { detail: "workspace overlaps project 'other'" } });
    await user.type(screen.getByLabelText(/^Name/), 'Demo app');
    for (let i = 0; i < 3; i += 1) await user.click(screen.getByRole('button', { name: /^Next/ }));
    await user.click(screen.getByRole('button', { name: 'Create the project' }));
    expect(await screen.findByText("workspace overlaps project 'other'")).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Change the folder' }));
    expect(screen.getByRole('heading', { name: 'Project folder' })).toBeInTheDocument();
  });
});
