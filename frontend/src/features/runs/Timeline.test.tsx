import { describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Approval } from '../../api/types';
import { event, renderWithProviders } from '../../test/utils';
import { Timeline, TimelineProvider } from './Timeline';

function renderTimeline(events: ReturnType<typeof event>[], approvals: Approval[] = [], onInspect = vi.fn()) {
  return renderWithProviders(
    <TimelineProvider approvals={approvals} onInspect={onInspect} currentRunId="run1">
      <Timeline events={events} />
    </TimelineProvider>,
  );
}

describe('Timeline: one visual identity per event source', () => {
  it('renders agent, tool, runtime and owner events with their source label', () => {
    const events = [
      event('run.started', 'runtime', { agent_id: 'research', provider: 'claude-code', model: 'sonnet' }),
      event('step.started', 'runtime', { step: 1 }),
      event('model.response', 'runtime', { model: 'claude-opus-5-5', usage: { input_tokens: 1200, output_tokens: 300 }, cost_usd: 0.0108, cost_estimated: true, duration_ms: 900 }),
      event('agent.reasoning', 'agent', { text: 'Need to read the README first.', kind: 'provider_summary' }),
      event('agent.message', 'agent', { text: 'Reading the README.' }),
      event('agent.tool_call', 'agent', { tool_call_id: 'c1', tool: 'fs_read', input: { path: 'README.md' } }),
      event('tool.permission', 'runtime', { tool_call_id: 'c1', tool: 'fs_read', decision: 'allow', rule: 'default' }),
      event('tool.started', 'tool', { tool_call_id: 'c1', tool: 'fs_read' }),
      event('tool.completed', 'tool', { tool_call_id: 'c1', tool: 'fs_read', duration_ms: 15, output: '1: # Title' }),
      event('run.cancel_requested', 'user', { actor: 'owner' }),
    ];
    const { container } = renderTimeline(events);

    // Each source has its own row style and label.
    for (const source of ['agent', 'tool', 'runtime', 'user']) {
      expect(container.querySelectorAll(`li[data-source="${source}"]`).length).toBeGreaterThan(0);
    }
    const userRow = container.querySelector('li[data-type="run.cancel_requested"]') as HTMLElement;
    expect(within(userRow).getByText('Owner')).toBeInTheDocument();
    const toolRow = container.querySelector('li[data-type="tool.completed"]') as HTMLElement;
    expect(within(toolRow).getByText('Tool')).toBeInTheDocument();
    expect(within(toolRow).getByText('15 ms')).toBeInTheDocument();
    const runtimeRow = container.querySelector('li[data-type="model.response"]') as HTMLElement;
    expect(within(runtimeRow).getByText('Runtime')).toBeInTheDocument();
    expect(within(runtimeRow).getByText(/\$0\.01 estimated/)).toBeInTheDocument();

    // Provider-supplied reasoning is labelled as a summary, not as the model's thoughts.
    const reasoning = container.querySelector('li[data-type="agent.reasoning"]') as HTMLElement;
    expect(within(reasoning).getByText('Agent')).toBeInTheDocument();
    expect(within(reasoning).getByText('Reasoning summary')).toBeInTheDocument();
    expect(within(reasoning).getByText('Need to read the README first.')).toBeInTheDocument();

    // Message text is shown as returned.
    expect(screen.getByText('Reading the README.')).toBeInTheDocument();
  });

  it('groups by step and gathers the events of one tool call in a card', () => {
    const events = [
      event('step.started', 'runtime', { step: 1 }),
      event('agent.tool_call', 'agent', { tool_call_id: 'c1', tool: 'fs_read', input: { path: 'a.txt' } }),
      event('tool.permission', 'runtime', { tool_call_id: 'c1', tool: 'fs_read', decision: 'allow', rule: 'default' }),
      event('tool.failed', 'tool', { tool_call_id: 'c1', tool: 'fs_read', error: "'a.txt' does not exist", duration_ms: 3 }),
      event('step.started', 'runtime', { step: 2 }),
      event('agent.final', 'agent', { output: { answer: 'no file' } }),
    ];
    const { container } = renderTimeline(events);
    expect(screen.getByRole('region', { name: 'Step 1' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Step 2' })).toBeInTheDocument();

    const cards = container.querySelectorAll('li[data-kind="tool-call"]');
    expect(cards).toHaveLength(1);
    const card = cards[0] as HTMLElement;
    expect(within(card).getByText('Failed')).toBeInTheDocument();
    expect(within(card).getByText("'a.txt' does not exist")).toBeInTheDocument();
    const sources = [...card.querySelectorAll('li[data-source]')].map((li) => li.getAttribute('data-source'));
    expect(sources).toEqual(['agent', 'runtime', 'tool']);

    // Structured final output is shown as JSON.
    expect(screen.getByText('Final answer')).toBeInTheDocument();
    expect(screen.getByText(/"answer": "no file"/)).toBeInTheDocument();
  });

  it('links delegations to the child run and opens raw JSON on inspect', async () => {
    const onInspect = vi.fn();
    const delegation = event('delegation.started', 'runtime', { child_run_id: 'child123456', agent_id: 'testing', task: 'run tests' });
    renderTimeline([delegation], [], onInspect);
    expect(screen.getByRole('link', { name: /Child run/ })).toHaveAttribute('href', '/runs/child123456');
    await userEvent.click(screen.getByRole('button', { name: `Inspect raw event ${delegation.id}` }));
    expect(onInspect).toHaveBeenCalledWith(delegation);
  });

  it('shows an inline approval card with actions while the approval is pending', () => {
    const approval: Approval = {
      id: 'ap1',
      run_id: 'run1',
      root_run_id: 'run1',
      agent_id: 'software-engineering',
      tool: 'fs_write',
      tool_call_id: 'c9',
      args: { path: 'notes.md', content: 'x' },
      risk: 'write',
      reason: 'Write the notes',
      status: 'pending',
      note: null,
      created_at: '2026-11-11T10:00:00+00:00',
      decided_at: null,
      expires_at: '2099-01-01T00:00:00+00:00',
    };
    renderTimeline(
      [
        event('step.started', 'runtime', { step: 1 }),
        event('agent.tool_call', 'agent', { tool_call_id: 'c9', tool: 'fs_write', input: approval.args }),
        event('approval.requested', 'runtime', { approval_id: 'ap1', tool_call_id: 'c9', tool: 'fs_write', args: approval.args, risk: 'write' }),
      ],
      [approval],
    );
    const card = screen.getByRole('article', { name: /^Approval request: / });
    expect(within(card).getByRole('button', { name: 'Approve' })).toBeEnabled();
    expect(within(card).getByRole('button', { name: 'Reject' })).toBeEnabled();
    expect(within(card).getByText('Write the notes')).toBeInTheDocument();
  });
});
