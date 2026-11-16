// Labels for the detailed map: team member names, initials, wrapped titles, plain statuses, accessible descriptions.

import type { ExecutionGraph, GraphNode, TaskGraphNode } from '../../api/types';
import { describeAction, memberName, plainTaskText, workStatus } from '../../lib/plain';
import { isActive, type Tone } from '../../lib/status';

type AgentNames = ExecutionGraph['agents'];

/** Display name of a team member: the graph's agent table, then a fallback map (agents API), then a readable id. */
export function agentName(agentId: string | null | undefined, agents: AgentNames, fallback?: Record<string, string>): string {
  if (!agentId) return 'Team member';
  return agents[agentId]?.name || fallback?.[agentId] || memberName(agentId);
}

export function initials(name: string): string {
  let words = name
    .replace(/[_-]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  // "Data Agent" and "Documentation Agent" must not both become "DA".
  if (words.length > 1 && /^agent$/i.test(words[words.length - 1]!)) words = words.slice(0, -1);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return (words[0]![0]! + words[1]![0]!).toUpperCase();
}

/** Splits text into at most `maxLines` lines of about `maxChars`, with an ellipsis when cut. */
export function wrapText(text: string, maxChars: number, maxLines: number): string[] {
  const words = text.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const lines: string[] = [];
  let current = '';
  let consumed = 0;
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= maxChars) {
      current = candidate;
      consumed += 1;
      continue;
    }
    if (current) lines.push(current);
    current = '';
    if (lines.length === maxLines) break;
    current = word.length > maxChars ? `${word.slice(0, maxChars - 1)}…` : word;
    consumed += 1;
  }
  if (current && lines.length < maxLines) lines.push(current);
  if (lines.length === 0) return [''];
  const last = lines[lines.length - 1]!;
  if (consumed < words.length && !last.endsWith('…')) {
    lines[lines.length - 1] = last.length >= maxChars ? `${last.slice(0, maxChars - 1)}…` : `${last}…`;
  }
  return lines;
}

export function truncateLabel(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, Math.max(1, maxChars - 1))}…`;
}

/** Plain status of a node, as shown on the detailed map. */
const APPROVAL_STATUS: Record<string, { label: string; tone: Tone }> = {
  pending: { label: 'Waiting for you', tone: 'amber' },
  approved: { label: 'Approved', tone: 'green' },
  rejected: { label: 'Declined', tone: 'red' },
  expired: { label: 'Expired', tone: 'slate' },
  cancelled: { label: 'Withdrawn', tone: 'slate' },
};

const RESULT_STATUS: Record<string, { label: string; tone: Tone }> = {
  pending: { label: 'Not ready yet', tone: 'gray' },
  completed: { label: 'Done', tone: 'green' },
  failed: { label: "Couldn't finish", tone: 'red' },
  cancelled: { label: 'Stopped', tone: 'slate' },
};

export function nodeStatus(node: GraphNode): { label: string; tone: Tone } {
  switch (node.kind) {
    case 'approval':
      return APPROVAL_STATUS[node.status] ?? { label: node.status, tone: 'gray' };
    case 'result':
      return RESULT_STATUS[node.status] ?? { label: node.status, tone: 'gray' };
    default: {
      const plain = workStatus(node.status);
      return { label: plain.label, tone: plain.tone };
    }
  }
}

/** What a screen reader announces for a node: what it is, who does it, its status. */
export function nodeAriaLabel(node: GraphNode, graph: Pick<ExecutionGraph, 'agents' | 'paused' | 'title'>, fallback?: Record<string, string>): string {
  switch (node.kind) {
    case 'root':
      // The graph's title is the request; the root's label names who it was given to (team member or team).
      return [
        `Your request: ${plainTaskText(graph.title)}`,
        node.agent_id ? `Given to ${agentName(node.agent_id, graph.agents, fallback)}` : node.label || node.team_id ? `Team ${node.label || node.team_id}` : '',
        `Status: ${nodeStatus(node).label}${graph.paused && isActive(node.status) ? ', paused' : ''}`,
      ]
        .filter(Boolean)
        .join('. ');
    case 'task':
      return taskAriaLabel(node, graph.agents, fallback);
    case 'approval':
      return `Approval: ${describeAction(node.tool, node.args).title}. Status: ${nodeStatus(node).label}`;
    case 'result':
      return `Final result. Status: ${nodeStatus(node).label}`;
    default:
      return 'Box';
  }
}

function taskAriaLabel(node: TaskGraphNode, agents: AgentNames, fallback?: Record<string, string>): string {
  const parts = [`Step: ${node.title}`, `Team member: ${agentName(node.agent_id, agents, fallback)}`, `Status: ${nodeStatus(node).label}`];
  if (node.attempts > 1) parts.push(`Tried ${node.attempts} times`);
  if (node.pending_approvals > 0) parts.push(node.pending_approvals === 1 ? 'Waiting for your approval' : `${node.pending_approvals} approvals waiting for you`);
  return parts.join('. ');
}
