import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DashboardResponse } from '../api/types';
import { AuthProvider } from '../auth/AuthProvider';
import { SCRIPTED, SIGNED_OUT, claudeProvider } from '../features/work/testFixtures';
import { mockFetch, renderWithProviders, type RecordedCall } from '../test/utils';
import { SettingsPage, resolveSettingsLocation } from './SettingsPage';

const DASHBOARD: DashboardResponse = {
  agents: { total: 12, enabled: 12 },
  runs: { running: 1, by_status: { completed: 7, failed: 1 } },
  window: { days: 30, runs: 9, completed: 7, failed: 1, success_rate: 0.875, input_tokens: 120_000, output_tokens: 30_000, cost_usd: 1.23 },
  per_day: [{ date: new Date().toISOString().slice(0, 10), runs: 2, completed: 1, cost_usd: 0.1 }],
  pending_approvals: 2,
  recent_runs: [],
  activity: [],
  providers: [],
  mcp: [],
};

const SETTINGS = {
  values: {
    'providers.default': 'claude-code',
    'providers.claude_code.default_model': null,
    'providers.claude_code.cli_path': null,
    'limits.max_steps': 40,
    'limits.timeout_s': 900,
    'limits.max_tokens': 400000,
    'limits.max_cost_usd': 5,
    'limits.max_output_tokens': 8000,
    'limits.max_concurrent_runs': 4,
    'limits.max_delegation_depth': 2,
    'limits.max_children_per_run': 8,
    'limits.max_parallel_members': 3,
    'limits.provider_retries': 2,
    'limits.approval_timeout_s': 1800,
    'limits.tool_output_chars': 20000,
  },
};

function setup(route: string, providers = [claudeProvider(), SCRIPTED]) {
  const fetch = mockFetch({
    'GET /api/auth/state': { has_owner: true, authenticated: true, username: 'owner', csrf_token: 'c' },
    'GET /api/providers': { items: providers },
    'GET /api/settings': SETTINGS,
    'PATCH /api/settings': (call: RecordedCall) => ({ body: { values: { ...SETTINGS.values, ...(call.body as object) } } }),
    'GET /api/dashboard': DASHBOARD,
    'GET /api/secrets': { items: [{ name: 'GITHUB_TOKEN', hint: '…a1b2', source: 'stored', updated_at: '2026-11-10T10:00:00+00:00', project_id: null }] },
    'GET /api/tokens': { items: [] },
  });
  renderWithProviders(
    <AuthProvider>
      <SettingsPage />
    </AuthProvider>,
    { route },
  );
  return fetch;
}

describe('Settings', () => {
  it('maps former links to the new sections', () => {
    expect(resolveSettingsLocation(new URLSearchParams('tab=providers'))).toEqual({ section: 'claude', part: null });
    expect(resolveSettingsLocation(new URLSearchParams('tab=secrets'))).toEqual({ section: 'keys', part: null });
    expect(resolveSettingsLocation(new URLSearchParams('tab=tokens'))).toEqual({ section: 'advanced', part: null });
    expect(resolveSettingsLocation(new URLSearchParams('section=usage'))).toEqual({ section: 'usage', part: null });
    expect(resolveSettingsLocation(new URLSearchParams(''))).toEqual({ section: 'claude', part: null });
  });

  it('opens on the Claude subscription, with a section navigation that marks the current one', async () => {
    setup('/settings', [SIGNED_OUT, SCRIPTED]);
    const nav = await screen.findByRole('navigation', { name: 'Settings sections' });
    expect(within(nav).getAllByRole('link').map((l) => l.textContent)).toEqual(['Claude subscription', 'Account', 'Appearance', 'Passwords & keys', 'Usage', 'Advanced']);
    expect(within(nav).getByRole('link', { name: 'Claude subscription' })).toHaveAttribute('aria-current', 'page');
    expect(await screen.findByRole('heading', { name: 'Connect your Claude subscription' })).toBeInTheDocument();
    expect(screen.getByText('Not signed in')).toBeInTheDocument();
    expect(screen.getByText('Your plan’s default')).toBeInTheDocument();
  });

  it('shows usage figures and explains that there is no per-token billing', async () => {
    setup('/settings?section=usage');
    expect(await screen.findByText('No per-token billing')).toBeInTheDocument();
    expect(screen.getByText('Tasks asked').nextSibling).toHaveTextContent('9');
    expect(screen.getByText('Success rate').nextSibling).toHaveTextContent('87.5%');
    expect(screen.getByText('150k')).toBeInTheDocument();
    expect(screen.queryByText('$1.23')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Pay-per-use equivalent' }));
    expect(screen.getByText('$1.23')).toBeInTheDocument();
  });

  it('explains how passwords and keys are kept, and never shows their values', async () => {
    setup('/settings?tab=secrets');
    expect(await screen.findByText(/Stored encrypted on this computer/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'How passwords and keys are kept' }));
    expect(screen.getByText(/work in every project/)).toBeInTheDocument();
    expect(await screen.findByText('GITHUB_TOKEN')).toBeInTheDocument();
    expect(screen.getByLabelText('Password or key')).toHaveAttribute('type', 'password');
  });

  it('keeps advanced options closed, each with a sentence, and opens the one a link asks for', async () => {
    setup('/settings?tab=data');
    expect(await screen.findByRole('button', { name: /Safety limits/ })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText(/Upper bounds that stop work that runs too long/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /History and clean-up/ })).toHaveAttribute('aria-expanded', 'true');
    // Access for other programs (tokens) is no longer offered.
    expect(screen.queryByRole('button', { name: /Access tokens/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Safety limits/ }));
    expect(await screen.findByLabelText(/Time to answer an approval/)).toHaveValue('1800');
  });

  it('has the account section with the password change', async () => {
    setup('/settings?section=account');
    expect(await screen.findByRole('heading', { name: 'Change your password' })).toBeInTheDocument();
    expect(screen.getByText(/not your Claude password/)).toBeInTheDocument();
    expect(screen.getByText('owner')).toBeInTheDocument();
  });

  it('lets the owner give their name and approve actions automatically', async () => {
    const { calls } = setup('/settings?section=account');
    const auto = await screen.findByRole('switch', { name: 'Approve actions automatically' });
    expect(auto).toHaveAttribute('aria-checked', 'false');
    await userEvent.click(auto);
    await waitFor(() => expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ 'permissions.mode': 'auto' }));
    const everything = await screen.findByRole('switch', { name: 'Also deploys, pushes and sending data out' });
    expect(screen.getByText(/still asks before deploying, pushing code or sending data out/)).toBeInTheDocument();
    await userEvent.click(everything);
    await waitFor(() => expect(calls.filter((c) => c.method === 'PATCH').at(-1)?.body).toEqual({ 'permissions.mode': 'all' }));
    await userEvent.type(screen.getByLabelText(/Your name/), 'Ada Lovelace');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.filter((c) => c.method === 'PATCH').at(-1)?.body).toEqual({ 'owner.name': 'Ada Lovelace' }));
  });
});
