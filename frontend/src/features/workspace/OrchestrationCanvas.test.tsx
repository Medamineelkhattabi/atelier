import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { workspaceGraph } from '../../test/graphFixtures';
import { renderWithProviders } from '../../test/utils';
import { OrchestrationCanvas } from './OrchestrationCanvas';

function renderCanvas(onSelect = vi.fn(), selectedId: string | null = null) {
  const graph = workspaceGraph();
  const view = renderWithProviders(<OrchestrationCanvas graph={graph} selectedId={selectedId} onSelect={onSelect} />);
  return { ...view, graph, onSelect };
}

describe('OrchestrationCanvas', () => {
  it('renders one focusable box per graph node, described in plain words', () => {
    const { container } = renderCanvas();
    const nodes = container.querySelectorAll('[data-node-id]');
    expect(nodes).toHaveLength(9);
    for (const node of nodes) expect(node).toHaveAttribute('tabindex', '0');

    expect(screen.getByRole('button', { name: /^Your request: Add input validation.*Given to Orchestrator.*Status: Working/ })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /^Step: / })).toHaveLength(6);
    expect(
      screen.getByRole('button', { name: 'Step: Review the security impact. Team member: Security reviewer. Status: Needs your approval. Tried 2 times. Waiting for your approval' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Approval: Run a command\. Status: Waiting for you/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Final result. Status: Not ready yet' })).toBeInTheDocument();
    // Node visuals: agent initials and status chip text.
    const security = container.querySelector('[data-node-id="t-c"]') as HTMLElement;
    expect(within(security).getByText('SR')).toBeInTheDocument();
    expect(within(security).getByText('Needs your approval')).toBeInTheDocument();
    expect(security).toHaveAttribute('data-status', 'waiting_approval');
  });

  it('draws every edge with its kind and animates only the edges the API marks active', () => {
    const { container, graph } = renderCanvas();
    const paths = [...container.querySelectorAll('path[data-edge-id]')];
    expect(paths).toHaveLength(graph.edges.length);
    const active = paths.filter((p) => p.getAttribute('data-active') === 'true');
    expect(active.map((p) => p.getAttribute('data-edge-id')).sort()).toEqual(['e2', 'e3', 'e4', 'e8', 'e9']);
    for (const path of paths) {
      const animated = path.getAttribute('class')?.split(' ').includes('edge-active') ?? false;
      expect(animated).toBe(path.getAttribute('data-active') === 'true');
    }
    // Kinds keep their own style: hand-offs are dashed, with their summary as label.
    expect(container.querySelector('path[data-edge-id="e10"]')).toHaveAttribute('data-kind', 'consolidates');
    expect(container.querySelector('path[data-edge-id="e4"]')).toHaveAttribute('stroke-dasharray', '6 4');
    expect(screen.getByText('Codebase map')).toBeInTheDocument();
    // The planner's line to a task that also waits for prerequisites is faint, not removed.
    expect(container.querySelector('path[data-edge-id="e11"]')).toHaveAttribute('data-faint', 'true');
    expect(container.querySelector('path[data-edge-id="e1"]')).not.toHaveAttribute('data-faint');
  });

  it('groups a nested plan in a labelled sub-lane', () => {
    const { container } = renderCanvas();
    const lane = container.querySelector('[data-lane-id]') as HTMLElement;
    expect(lane).not.toBeNull();
    expect(within(lane).getByText('Split by Software engineer · 2 steps')).toBeInTheDocument();
  });

  it('opens the inspector from the keyboard (Enter, Space) and the mouse', async () => {
    const { onSelect } = renderCanvas();
    const user = userEvent.setup();
    const node = screen.getByRole('button', { name: /^Step: Map the signup code/ });
    node.focus();
    expect(node).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(onSelect).toHaveBeenLastCalledWith('t-a');
    fireEvent.keyDown(screen.getByRole('button', { name: /^Final result/ }), { key: ' ' });
    expect(onSelect).toHaveBeenLastCalledWith('result');
    await user.click(screen.getByRole('button', { name: /^Approval: / }));
    expect(onSelect).toHaveBeenLastCalledWith('ap-1');
  });

  it('marks the selected node and offers zoom, fit and a legend', async () => {
    renderCanvas(vi.fn(), 't-b');
    expect(screen.getByRole('button', { name: /^Step: Write the tests/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /^Step: Map the signup code/ })).toHaveAttribute('aria-pressed', 'false');
    const user = userEvent.setup();
    expect(screen.getByLabelText('Zoom 100 percent')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(screen.getByLabelText('Zoom 120 percent')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Zoom out' }));
    expect(screen.getByLabelText('Zoom 100 percent')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Show legend' }));
    const legend = screen.getByRole('note', { name: 'Legend' });
    expect(within(legend).getByText('Hand-off')).toBeInTheDocument();
    expect(within(legend).getByText(/work in progress right now/)).toBeInTheDocument();
    expect(within(legend).getByText('Needs your approval')).toBeInTheDocument();
  });
});
