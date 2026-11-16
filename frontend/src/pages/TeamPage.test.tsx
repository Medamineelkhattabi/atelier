import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TEAM, toolInfo } from '../features/team/fixtures';
import { mockFetch, renderWithProviders } from '../test/utils';
import { TeamPage } from './TeamPage';

function setup(tools = [toolInfo('web_fetch'), toolInfo('fs_write'), toolInfo('shell_run')]) {
  const fetch = mockFetch({
    'GET /api/agents': { items: TEAM, load_errors: {} },
    'GET /api/tools': { items: tools },
  });
  renderWithProviders(<TeamPage />, { route: '/team' });
  return { ...fetch, user: userEvent.setup() };
}

const card = (name: string) => screen.getByRole('article', { name });

describe('My AI Team', () => {
  it('says in one line that the owner does not need to pick anyone, and explains approvals on demand', async () => {
    const { user } = setup();
    expect(await screen.findByRole('article', { name: 'Researcher' })).toBeInTheDocument();
    expect(screen.getByText('You don’t need to pick anyone: the Coordinator assigns the work.')).toBeInTheDocument();
    expect(screen.queryByText(/waits for your approval/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'How this works' }));
    expect(screen.getByText(/waits for your approval/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Quality checks/ })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /New member \(advanced\)/ })).toHaveAttribute('href', '/team/new');
  });

  it('shows each team member in plain words, never by its technical id, and keeps the Grader behind the scenes', async () => {
    setup();
    const list = await screen.findByRole('list', { name: 'Team members' });
    const names = within(list).getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    // The Coordinator leads the team: first.
    expect(names).toEqual(['Coordinator', 'Researcher', 'Planner', 'Software Engineer', 'Code Reviewer']);
    expect(within(list).queryByText('Grader')).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Behind the scenes' })).toHaveTextContent('Grader');

    // A card is short: name (linking to the profile), one line, badges and "Ask". The details are on the profile.
    const researcher = card('Researcher');
    expect(within(researcher).getByRole('link', { name: 'Researcher' })).toHaveAttribute('href', '/team/research');
    expect(within(researcher).getByText('Only reads')).toBeInTheDocument();
    expect(within(researcher).queryByText('You need facts with sources before deciding something')).not.toBeInTheDocument();
    expect(within(researcher).queryByRole('list', { name: 'What Researcher can do' })).not.toBeInTheDocument();
    expect(within(researcher).queryByRole('list', { name: 'Works with' })).not.toBeInTheDocument();
    expect(within(researcher).queryByText('research')).not.toBeInTheDocument();
    expect(within(researcher).getByRole('link', { name: 'Ask Researcher' })).toHaveAttribute('href', '/?agent=research');

    const engineer = card('Software Engineer');
    expect(within(engineer).getByText('Can make changes')).toHaveAttribute('title', 'Can make changes, and always asks you first.');
    expect(within(engineer).getByText('Asks first')).toBeInTheDocument();

    expect(within(card('Coordinator')).getByText('Leads the team')).toBeInTheDocument();
  });

  it('explains a turned-off team member and does not offer to ask it', async () => {
    setup();
    const reviewer = await screen.findByRole('article', { name: 'Code Reviewer' });
    expect(within(reviewer).getByText('Turned off')).toHaveAttribute('title', expect.stringMatching(/^Nobody can give it work while it is off/));
    expect(within(reviewer).getByRole('button', { name: 'Ask Code Reviewer' })).toBeDisabled();
  });

  it('finds who can help from a plain request, and offers the whole team when nobody matches', async () => {
    const { user } = setup();
    const search = await screen.findByLabelText('What do you need help with?');
    await user.type(search, 'bugs in my code');
    const list = screen.getByRole('list', { name: 'Team members' });
    expect(within(list).getAllByRole('heading', { level: 2 })[0]).toHaveTextContent('Code Reviewer');

    await user.clear(search);
    await user.type(search, 'translate a poem');
    expect(screen.getByText('Nobody matches “translate a poem”')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Ask the team/ })).toHaveAttribute('href', '/?task=translate%20a%20poem');
    await user.click(screen.getByRole('button', { name: 'Show everyone' }));
    expect(screen.getAllByRole('article')).toHaveLength(5);
  });

  it('filters on who only reads and who can make changes', async () => {
    const { user } = setup();
    await screen.findByRole('article', { name: 'Researcher' });
    await user.click(screen.getByRole('button', { name: /Can make changes/ }));
    expect(screen.getAllByRole('article').map((a) => within(a).getByRole('heading', { level: 2 }).textContent)).toEqual(['Software Engineer']);
    await user.click(screen.getByRole('button', { name: /Only reads/ }));
    expect(screen.queryByRole('article', { name: 'Software Engineer' })).not.toBeInTheDocument();
    expect(screen.getByRole('article', { name: 'Researcher' })).toBeInTheDocument();
  });

  it('explains what to do when the team cannot be loaded', async () => {
    mockFetch({ 'GET /api/agents': { status: 500, body: { detail: 'database is locked' } }, 'GET /api/tools': { items: [] } });
    renderWithProviders(<TeamPage />);
    expect(await screen.findByText(/Check that the platform is still running, then try again/)).toBeInTheDocument();
    expect(screen.getByText('database is locked')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});
