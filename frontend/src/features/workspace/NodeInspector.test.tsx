import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { setCsrfToken } from '../../api/client';
import { runDetail, workspaceGraph } from '../../test/graphFixtures';
import { mockFetch, renderWithProviders } from '../../test/utils';
import { NodeInspector, OutputPreview } from './NodeInspector';

const TOOLS = {
  items: [
    { name: 'fs_read', description: 'Read a file', category: 'fs', risk: 'read', default_permission: 'allow', untrusted_output: false, timeout_s: 10, input_schema: {}, source: 'builtin', global_permission: null, used_by: [] },
    { name: 'shell_run', description: 'Run a command', category: 'shell', risk: 'execute', default_permission: 'ask', untrusted_output: true, timeout_s: 60, input_schema: {}, source: 'builtin', global_permission: null, used_by: [] },
  ],
};

afterEach(() => setCsrfToken(null));

function renderInspector(nodeId: string, extra: Record<string, unknown> = {}) {
  const onSelect = vi.fn();
  const onApprovalDecided = vi.fn();
  const fetch = mockFetch({ 'GET /api/agents': { items: [], load_errors: {} }, 'GET /api/tools': TOOLS, ...extra });
  renderWithProviders(
    <NodeInspector graph={workspaceGraph()} nodeId={nodeId} run={runDetail()} onSelect={onSelect} onClose={vi.fn()} onApprovalDecided={onApprovalDecided} />,
  );
  return { ...fetch, onSelect, onApprovalDecided };
}

describe('NodeInspector: task node', () => {
  it('shows who works on it, why, the task, its input, errors, tools and usage', async () => {
    renderInspector('t-c');
    // Team member identity and responsibility come from the graph's agent table (never the raw id).
    expect(screen.getByRole('link', { name: 'Security reviewer' })).toHaveAttribute('href', '/team/security-reviewer');
    expect(screen.queryByText('security-reviewer')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Step' })).toBeInTheDocument();
    expect(screen.getByText('Finds security problems before they ship.')).toBeInTheDocument();
    expect(screen.getByText('Checks input handling for injection risks.')).toBeInTheDocument();
    expect(screen.getByText('Review the security impact')).toBeInTheDocument();
    expect(screen.getByText('tried 2 times')).toBeInTheDocument();
    expect(screen.getByText('Signup handler and its callers.')).toBeInTheDocument();
    expect(screen.getByText('First attempt timed out.')).toBeInTheDocument();
    expect(screen.getByText('It took longer than the time allowed.')).toBeInTheDocument();

    // Tools used, with their count and (once the tools list is loaded) a plain-language risk.
    const tools = screen.getByRole('list', { name: 'Tools used' });
    expect(within(tools).getByText('fs_read')).toBeInTheDocument();
    expect(within(tools).getByText('×3')).toBeInTheDocument();
    expect(within(tools).getByText('×1')).toBeInTheDocument();
    expect(await within(tools).findByText('Runs commands or programs on this machine.')).toBeInTheDocument();

    // Usage: duration, tokens and the estimate, labelled as not billed.
    expect(screen.getByText('42 s')).toBeInTheDocument();
    expect(screen.getByText('1.2k / 300')).toBeInTheDocument();
    expect(screen.getByText('$0.01')).toBeInTheDocument();
    expect(screen.getAllByText('API-equivalent estimate, not billed').length).toBeGreaterThan(0);

    // Every attempt's run is linked.
    expect(screen.getByRole('link', { name: /run-c1/ })).toHaveAttribute('href', '/runs/run-c1');
    expect(screen.getByRole('link', { name: /run-c2/ })).toHaveAttribute('href', '/runs/run-c2');
    expect(screen.getByRole('link', { name: /Technical details of this step/ })).toHaveAttribute('href', '/runs/run-c2');
  });

  it('decides a pending approval inline, through the API with the CSRF header', async () => {
    setCsrfToken('csrf-ws');
    const { calls, onApprovalDecided } = renderInspector('t-c', {
      'POST /api/approvals/appr-1/decision': { id: 'appr-1', status: 'approved' },
    });
    const card = screen.getByRole('article', { name: 'Approval request: Run a command' });
    expect(within(card).getByText('Run the static analyser')).toBeInTheDocument();
    expect(within(card).getByText('bandit -r app')).toBeInTheDocument();
    await userEvent.click(within(card).getByRole('button', { name: 'Approve' }));

    expect(await screen.findByText(/^Approved — /)).toBeInTheDocument();
    const decision = calls.find((c) => c.path === '/api/approvals/appr-1/decision');
    expect(decision).toMatchObject({ method: 'POST', body: { approve: true } });
    expect(decision?.headers['x-csrf-token']).toBe('csrf-ws');
    expect(onApprovalDecided).toHaveBeenCalledTimes(1);
  });

  it('lists the hand-offs a task received and the tasks it waits for', async () => {
    const { onSelect } = renderInspector('t-b');
    expect(screen.getByText('Codebase map')).toBeInTheDocument();
    const prerequisite = screen.getAllByRole('button', { name: /Map the signup code/ })[0]!;
    await userEvent.click(prerequisite);
    expect(onSelect).toHaveBeenCalledWith('t-a');
    // Its own sub-plan is listed too.
    expect(screen.getByText('Split into 2 steps')).toBeInTheDocument();
  });
});

describe('NodeInspector: root node', () => {
  it('shows the request, the steps summary and where the result will appear', () => {
    renderInspector('root');
    expect(screen.getByText('Add input validation to the signup handler, with tests.')).toBeInTheDocument();
    expect(screen.getByText(/6 steps, including 1 group of steps split by team members/)).toBeInTheDocument();
    expect(screen.getByText('The final result appears here when the task is done.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Technical details/ })).toHaveAttribute('href', '/runs/root1');
  });
});

describe('OutputPreview', () => {
  it('shows the shared envelope in words and keeps the full JSON on demand', async () => {
    renderWithProviders(<OutputPreview text={JSON.stringify({ status: 'partial', summary: 'Two of three files read.', issues: ['notes.pdf is encrypted'], findings: [] })} />);
    expect(screen.getByText('Partly done')).toBeInTheDocument();
    expect(screen.getByText('Two of three files read.')).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Issues reported' })).toHaveTextContent('notes.pdf is encrypted');
    await userEvent.click(screen.getByRole('button', { name: 'Technical details (raw data)' }));
    expect(screen.getByText(/"findings": \[\]/)).toBeInTheDocument();
  });

  it('shows a truncated (unparseable) preview as text', () => {
    renderWithProviders(<OutputPreview text='{"status": "complete", "summary": "cut...' />);
    expect(screen.getByText('{"status": "complete", "summary": "cut...')).toBeInTheDocument();
  });
});
