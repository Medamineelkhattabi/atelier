import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { mockFetch, renderWithProviders } from '../../test/utils';
import { SCRIPTED, SIGNED_OUT, claudeProvider } from '../work/testFixtures';
import { aiAccess, canStart, notReadyReason } from './aiAccess';
import { ClaudeConnection } from './ClaudeConnection';

describe('aiAccess', () => {
  it('reads the state of the provider a task would use', () => {
    expect(aiAccess(undefined)).toBeNull();
    expect(aiAccess([claudeProvider(), SCRIPTED])?.kind).toBe('ready');
    expect(aiAccess([SIGNED_OUT, SCRIPTED])?.kind).toBe('signed_out');
    expect(aiAccess([claudeProvider({ is_default: false }), { ...SCRIPTED, is_default: true }])?.kind).toBe('test');
    // A team member's own provider wins over the default.
    expect(aiAccess([SIGNED_OUT, SCRIPTED], 'scripted')?.kind).toBe('test');
    expect(aiAccess([claudeProvider({ configured: false, cli_path: null, auth: 'none', detail: 'Claude Code CLI not found.' })])?.kind).toBe('no_program');
    expect(aiAccess([claudeProvider({ configured: false, auth: 'blocked', detail: 'Blocked: paid credential variables present (ANTHROPIC_API_KEY).' })])?.kind).toBe('blocked');
    const limited = aiAccess([claudeProvider({ configured: false, usage: { blocked_until: '2026-11-11T15:00:00+00:00', window: 'five_hour', reason: 'limit', message: 'limit reached' } })]);
    expect(limited?.kind).toBe('limit');
    expect(notReadyReason(limited)).toMatch(/^Your Claude plan’s usage limit is reached until /);
  });

  it('lets tasks start only when ready or in (labelled) test mode', () => {
    expect(canStart(aiAccess([claudeProvider()]))).toBe(true);
    expect(canStart(aiAccess([{ ...SCRIPTED, is_default: true }]))).toBe(true);
    expect(canStart(aiAccess([SIGNED_OUT]))).toBe(false);
    expect(canStart(null)).toBe(false);
    expect(notReadyReason(aiAccess([SIGNED_OUT]))).toBe('Connect your Claude subscription first (see below).');
  });
});

describe('ClaudeConnection', () => {
  const signedOut = aiAccess([SIGNED_OUT])!;

  it('opens the sign-in window on this computer, then lets the owner check again', async () => {
    const { calls } = mockFetch({ 'POST /api/providers/claude-code/sign-in': { opened: true, reason: '', command: 'pae claude-login' } });
    const onCheckAgain = vi.fn();
    renderWithProviders(<ClaudeConnection state={signedOut} onCheckAgain={onCheckAgain} />);
    expect(screen.getByRole('heading', { name: 'Connect your Claude subscription' })).toBeInTheDocument();
    const user = userEvent.setup();
    // The privacy note and the technical detail are one click away.
    expect(screen.queryByText(/never sees your password/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'About this connection' }));
    expect(screen.getByText(/never sees your password/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Connect my Claude subscription' }));
    expect(await screen.findByText('A sign-in window opened on this computer.')).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'POST' && c.path === '/api/providers/claude-code/sign-in')).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Check again' }));
    expect(onCheckAgain).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Still not connected/)).toBeInTheDocument();
  });

  it('shows why no window could open and the command to run instead, with a copy button', async () => {
    mockFetch({
      'POST /api/providers/claude-code/sign-in': {
        opened: false,
        reason: 'The platform is not running on this computer only (it listens on a network address).',
        command: 'pae claude-login',
      },
    });
    renderWithProviders(<ClaudeConnection state={signedOut} onCheckAgain={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Connect my Claude subscription' }));
    expect(await screen.findByText(/listens on a network address/)).toBeInTheDocument();
    expect(screen.getByText('pae claude-login')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy the command' })).toBeInTheDocument();
  });

  it('explains a reached usage limit and can clear it once it has reset', async () => {
    const { calls } = mockFetch({ 'POST /api/usage/clear': { block: null } });
    const state = aiAccess([claudeProvider({ configured: false, usage: { blocked_until: '2026-11-11T15:00:00+00:00', window: 'five_hour', reason: 'limit', message: 'five-hour limit reached' } })])!;
    renderWithProviders(<ClaudeConnection state={state} onCheckAgain={vi.fn()} />);
    expect(screen.getByRole('heading', { name: 'Your Claude plan’s usage limit is reached' })).toBeInTheDocument();
    expect(screen.getByText(/never switches to paid usage/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'The limit has already reset' }));
    await vi.waitFor(() => expect(calls.some((c) => c.path === '/api/usage/clear')).toBe(true));
  });

  it('labels test mode honestly and shows nothing on Home when connected', () => {
    mockFetch({});
    const { rerender } = renderWithProviders(<ClaudeConnection state={aiAccess([{ ...SCRIPTED, is_default: true }])!} onCheckAgain={vi.fn()} />);
    expect(screen.getByText('Test mode: answers come from a script, not an AI model')).toBeInTheDocument();
    rerender(<ClaudeConnection state={aiAccess([claudeProvider()])!} onCheckAgain={vi.fn()} />);
    expect(screen.queryByText(/Connect/)).not.toBeInTheDocument();
    rerender(<ClaudeConnection state={aiAccess([claudeProvider()])!} onCheckAgain={vi.fn()} showWhenReady />);
    expect(screen.getByText('Connected to your Claude subscription')).toBeInTheDocument();
  });
});
