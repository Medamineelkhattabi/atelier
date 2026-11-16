import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ToolInfo } from '../api/types';
import { ENGINES, TEAM, toolInfo } from '../features/team/fixtures';
import { mockFetch, renderWithProviders, type RecordedCall } from '../test/utils';
import { ToolsPage } from './ToolsPage';

const TOOLS = [
  toolInfo('fs_read', { used_by: ['research', 'software-engineering'] }),
  toolInfo('fs_write', { used_by: ['software-engineering'] }),
  toolInfo('web_fetch', { used_by: ['research'] }),
  toolInfo('mcp__github__create_issue', { source: 'mcp:github', category: 'mcp:github' }),
];

function setup() {
  let tools = TOOLS;
  const fetch = mockFetch({
    'GET /api/tools': () => ({ body: { items: tools } }),
    'GET /api/agents': { items: TEAM, load_errors: {} },
    'GET /api/engines': { items: ENGINES },
    'GET /api/settings': { values: { 'permissions.tools': {}, 'mcp.servers': [] } },
    'GET /api/mcp': {
      items: [
        { name: 'github', status: 'connected', error: null, tools: ['mcp__github__create_issue'], config: { name: 'github', command: 'npx', permission: 'ask' } },
      ],
    },
    'PUT /api/tools/web_fetch/permission': (call: RecordedCall) => {
      const permission = (call.body as { permission: ToolInfo['global_permission'] }).permission;
      tools = tools.map((t) => (t.name === 'web_fetch' ? { ...t, global_permission: permission } : t));
      return { body: { name: 'web_fetch', global_permission: permission } };
    },
    'PUT /api/tools/claude_code.Edit/permission': { name: 'claude_code.Edit', global_permission: 'deny' },
  });
  renderWithProviders(<ToolsPage />, { route: '/tools' });
  return { ...fetch, user: userEvent.setup() };
}

describe('Tools & Connections', () => {
  it('groups the team’s abilities in plain words, with who has them and the current rule', async () => {
    const { user } = setup();
    const groups = await screen.findByRole('list', { name: 'Ability groups' });
    const web = within(groups).getByRole('article', { name: 'Read web pages' });
    // The rules of each action are one click away.
    expect(within(web).queryByRole('list', { name: 'Read web pages: actions and rules' })).not.toBeInTheDocument();
    await user.click(within(web).getByRole('button', { name: 'Rules for 1 action' }));
    const actions = within(web).getByRole('list', { name: 'Read web pages: actions and rules' });
    expect(within(actions).getByText('Open a web page')).toBeInTheDocument();
    expect(within(actions).getByText('Asks you first, except websites you allowed')).toBeInTheDocument();
    expect(within(actions).getByText('Standard rule')).toBeInTheDocument();
    expect(within(web).getByRole('link', { name: 'Researcher' })).toHaveAttribute('href', '/team/research');

    const files = within(groups).getByRole('article', { name: 'Change files' });
    await user.click(within(files).getByRole('button', { name: /^Rules for/ }));
    expect(within(files).getByText('Create or change a file')).toBeInTheDocument();
    // Claude Code's own editing tool is listed too, so blocking file changes is complete.
    expect(within(files).getByText('Edit a file, with Claude Code’s own tools')).toBeInTheDocument();
    // Connection tools are not mixed into the built-in groups.
    expect(within(groups).queryByText(/Create issue/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'What the choices mean' }));
    expect(screen.getByText(/must ask you before doing it, every time/)).toBeInTheDocument();
  });

  it('changes the owner rule of an action with the existing permission API', async () => {
    const { user, calls } = setup();
    const groups = await screen.findByRole('list', { name: 'Ability groups' });
    await user.click(within(within(groups).getByRole('article', { name: 'Read web pages' })).getByRole('button', { name: /^Rules for/ }));
    await user.click(within(within(groups).getByRole('article', { name: 'Change files' })).getByRole('button', { name: /^Rules for/ }));
    const select = screen.getByLabelText('Rule for “Open a web page”');
    expect(select).toHaveValue('');
    await user.selectOptions(select, 'deny');
    await screen.findByText('Your rule');
    expect(screen.getByLabelText('Rule for “Open a web page”')).toHaveValue('deny');
    expect(calls.find((c) => c.method === 'PUT')).toMatchObject({ path: '/api/tools/web_fetch/permission', body: { permission: 'deny' } });

    await user.selectOptions(screen.getByLabelText('Rule for “Edit a file, with Claude Code’s own tools”'), 'deny');
    expect(calls.filter((c) => c.method === 'PUT').at(-1)).toMatchObject({ path: '/api/tools/claude_code.Edit/permission', body: { permission: 'deny' } });
  });

  it('lists the AI agents the team can run on, how to install them and how to sign in', async () => {
    setup();
    expect(screen.getByText(/Each one uses its own sign-in; the platform never asks for an API key\./)).toBeInTheDocument();
    const list = await screen.findByRole('list', { name: 'AI agents' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows.map((row) => row.querySelector('span')?.textContent)).toEqual(['Claude Code', 'Gemini CLI', 'Codex']);

    expect(within(rows[0]!).getByText('Installed')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('Runs on your Claude plan.')).toBeInTheDocument();
    expect(within(rows[0]!).queryByText(/Sign in once/)).not.toBeInTheDocument();

    expect(within(rows[1]!).getByText('Installed')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('Runs on your Google account.')).toBeInTheDocument();
    expect(within(rows[1]!).getByText(/Sign in once:/)).toHaveTextContent('Sign in once: Run gemini once and choose Sign in with Google');
    expect(within(rows[1]!).queryByText(/Install:/)).not.toBeInTheDocument();

    expect(within(rows[2]!).getByText('Not installed')).toBeInTheDocument();
    expect(within(rows[2]!).getByText('npm install -g @zed-industries/codex-acp').tagName).toBe('CODE');
    expect(within(rows[2]!).queryByText(/Sign in once/)).not.toBeInTheDocument();
  });

  it('explains connections and keeps the technical table under Advanced', async () => {
    const { user } = setup();
    await user.click(await screen.findByRole('button', { name: 'About connections' }));
    expect(screen.getByText(/Each connection's actions ask you first by default/)).toBeInTheDocument();
    const connections = await screen.findByRole('list', { name: 'Connections' });
    expect(within(connections).getByText('Connected')).toBeInTheDocument();
    expect(within(connections).getByText(/asks you first/)).toBeInTheDocument();
    expect(screen.queryByText('Tool registry')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Advanced: every tool/ }));
    expect(screen.getByText('Tool registry')).toBeInTheDocument();
    expect(screen.getByLabelText('Global permission for fs_write')).toBeInTheDocument();
  });
});
