// Approvals in plain words: who asks, what they want to do, and what each status means.

import type { Agent, JsonValue } from '../../api/types';
import { describeAction, memberName, type PlainAction, type PlainStatus } from '../../lib/plain';

export interface ApprovalWords {
  /** "Researcher", or "A team member" when unknown. */
  who: string;
  action: PlainAction;
  /** "Researcher wants to read the web page https://…". */
  sentence: string;
}

export function approvalWords(
  approval: { tool: string; args: JsonValue | unknown; agent_id?: string | null },
  agents?: Pick<Agent, 'id' | 'name'>[],
): ApprovalWords {
  const who = approval.agent_id ? memberName(approval.agent_id, agents) : 'A team member';
  const action = describeAction(approval.tool, approval.args, agents);
  return { who, action, sentence: `${who} wants to ${action.phrase}.` };
}

const STATUS: Record<string, PlainStatus> = {
  pending: { label: 'Waiting for you', tone: 'amber', hint: 'Nothing happens until you decide.' },
  approved: { label: 'Approved', tone: 'green', hint: 'You allowed it to go ahead.' },
  rejected: { label: 'Rejected', tone: 'red', hint: 'You refused it, so it was not done.' },
  expired: { label: 'Expired', tone: 'slate', hint: 'Nobody answered in time, so it was not done.' },
  cancelled: { label: 'Cancelled', tone: 'slate', hint: 'The task stopped before anyone decided, so it was not done.' },
};

export function approvalStatus(status: string | null | undefined): PlainStatus {
  return (status && STATUS[status]) || { label: 'Unknown', tone: 'gray', hint: '' };
}
