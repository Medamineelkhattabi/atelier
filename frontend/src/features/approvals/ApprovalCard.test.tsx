import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { setCsrfToken } from '../../api/client';
import type { Approval } from '../../api/types';
import { AGENTS } from '../work/testFixtures';
import { mockFetch, renderWithProviders } from '../../test/utils';
import { ApprovalCard } from './ApprovalCard';

const approval: Approval = {
  id: 'ap1',
  run_id: 'run-step',
  root_run_id: 'run1',
  agent_id: 'research',
  tool: 'shell_run',
  tool_call_id: 'c1',
  args: { command: 'pytest -q' },
  risk: 'execute',
  reason: 'Run the test suite',
  status: 'pending',
  note: null,
  created_at: '2026-11-11T10:00:00+00:00',
  decided_at: null,
  expires_at: '2099-01-01T00:00:00+00:00',
  run_task: 'Fix the failing test\n\n## Input\n{"a": 1}',
  project_id: 'alpha',
};

afterEach(() => setCsrfToken(null));

describe('ApprovalCard', () => {
  it('says in plain words who wants to do what, why, with a preview, the task, and the time left', () => {
    mockFetch({});
    renderWithProviders(<ApprovalCard approval={approval} showRun agents={AGENTS} projectName="Alpha" />);
    expect(screen.getByRole('article', { name: 'Approval request: Run a command' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Researcher wants to run a command in the project folder.' })).toBeInTheDocument();
    expect(screen.getByText(/Commands can change files or settings on this computer/)).toBeInTheDocument();
    expect(screen.getByText('Run the test suite')).toBeInTheDocument();
    expect(screen.getByText('Command')).toBeInTheDocument();
    expect(screen.getByText('pytest -q')).toBeInTheDocument();
    expect(screen.getByText('“Fix the failing test”')).toBeInTheDocument();
    expect(screen.getByText('· Project Alpha')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open the task' })).toHaveAttribute('href', '/workspace/run1');
    expect(screen.getByText(/left to decide$/)).toBeInTheDocument();
    // While pending, the buttons say it all: no "Waiting for you" badge, and the message field is one click away.
    expect(screen.queryByText('Waiting for you')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Message to the team member (optional)')).not.toBeInTheDocument();
  });

  it('keeps tool id, risk level and raw arguments in closed technical details', async () => {
    mockFetch({});
    renderWithProviders(<ApprovalCard approval={approval} agents={AGENTS} />);
    expect(screen.queryByText('shell_run')).not.toBeInTheDocument();
    expect(screen.queryByText(/"command": "pytest -q"/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Technical details' }));
    expect(screen.getByText('shell_run')).toBeInTheDocument();
    expect(screen.getByText(/^execute — Runs commands or programs/)).toBeInTheDocument();
    expect(screen.getByText(/"command": "pytest -q"/)).toBeInTheDocument();
  });

  it('approves with a message through the API, with the CSRF header', async () => {
    setCsrfToken('csrf-xyz');
    const onDecided = vi.fn();
    const { calls } = mockFetch({ 'POST /api/approvals/ap1/decision': { id: 'ap1', status: 'approved' } });
    renderWithProviders(<ApprovalCard approval={approval} onDecided={onDecided} agents={AGENTS} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Add a message' }));
    await user.type(screen.getByLabelText('Message to the team member (optional)'), 'only this once');
    await user.click(screen.getByRole('button', { name: 'Approve' }));

    expect(await screen.findByText('Approved — Researcher goes ahead.')).toBeInTheDocument();
    const decision = calls.find((c) => c.path === '/api/approvals/ap1/decision');
    expect(decision).toMatchObject({ method: 'POST', body: { approve: true, note: 'only this once' } });
    expect(decision?.headers['x-csrf-token']).toBe('csrf-xyz');
    expect(onDecided).toHaveBeenCalledWith({ id: 'ap1', status: 'approved' });
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    expect(screen.getByText('Approved')).toBeInTheDocument();
  });

  it('rejects without a message', async () => {
    const { calls } = mockFetch({ 'POST /api/approvals/ap1/decision': { id: 'ap1', status: 'rejected' } });
    renderWithProviders(<ApprovalCard approval={approval} agents={AGENTS} />);
    await userEvent.click(screen.getByRole('button', { name: 'Reject' }));
    expect(await screen.findByText('Rejected — Researcher will not do it and carries on without it.')).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ approve: false });
  });

  it('shows the server refusal and what to do', async () => {
    mockFetch({ 'POST /api/approvals/ap1/decision': { status: 409, body: { detail: 'approval is already expired' } } });
    renderWithProviders(<ApprovalCard approval={approval} agents={AGENTS} />);
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(await screen.findByText('approval is already expired')).toBeInTheDocument();
    expect(screen.getByText(/Refresh the page/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled();
  });

  it('has no actions once decided, and says what the decision meant', () => {
    mockFetch({});
    renderWithProviders(
      <ApprovalCard approval={{ ...approval, status: 'rejected', note: 'not now', decided_at: '2026-11-11T10:05:00+00:00' }} agents={AGENTS} collapsePreviewWhenDecided />,
    );
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    expect(screen.getByText('Rejected')).toBeInTheDocument();
    expect(screen.getByText(/You refused it, so it was not done/)).toBeInTheDocument();
    expect(screen.getByText('not now')).toBeInTheDocument();
    expect(screen.queryByText('pytest -q')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show the command' })).toBeInTheDocument();
  });

  it('reads a plan as numbered steps; "Start the plan" approves it', async () => {
    const { calls } = mockFetch({ 'POST /api/approvals/p1/decision': { id: 'p1', status: 'approved' } });
    const plan = {
      tasks: [
        { id: 'a', agent_id: 'research', title: 'Collect the facts', task: 'x', depends_on: [] },
        { id: 'b', agent_id: 'planning', title: 'Plan the move', task: 'y', depends_on: ['a'] },
      ],
    };
    renderWithProviders(
      <ApprovalCard approval={{ id: 'p1', tool: 'agent_run_plan', args: plan, risk: 'read', reason: 'Facts first.', status: 'pending', agent_id: 'orchestrator' }} agents={[...AGENTS, { id: 'orchestrator', name: 'Coordinator' }]} />,
    );
    expect(screen.getByRole('article', { name: 'Approval request: Check the plan' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Coordinator wants to start this plan (2 steps).' })).toBeInTheDocument();
    expect(within(screen.getByRole('list', { name: 'Plan' })).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      '1. Researcher — Collect the facts',
      '2. Planner — Plan the move (after 1)',
    ]);
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Start the plan' }));
    expect(await screen.findByText('Plan started.')).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ approve: true });
  });

  it('still works with the minimal data the timeline and workspace pass', () => {
    mockFetch({});
    renderWithProviders(<ApprovalCard approval={{ id: 'ap9', tool: 'fs_write', args: { path: 'notes.md', content: 'hi' }, risk: 'write', reason: null, status: 'pending', run_id: 'r1' }} />);
    expect(screen.getByRole('article', { name: 'Approval request: Create a file' })).toBeInTheDocument();
    expect(screen.getByText('A team member wants to create the file “notes.md” in the project folder.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled();
  });
});
