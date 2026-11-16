// Live feed of all new events (GET /api/stream, no replay). It does not render events:
// it only tells TanStack Query which cached lists are now stale (approval badge, dashboard,
// history, Agent Workspace executions, project stats).

import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { GLOBAL_STREAM_URL } from '../../api/endpoints';
import { qk } from '../../api/keys';
import type { RunEvent } from '../../api/types';

export type GlobalStreamState = 'connecting' | 'open' | 'reconnecting' | 'closed' | 'unsupported';

const FLUSH_MS = 1000;
const RUN_LIFECYCLE = new Set([
  'run.queued',
  'run.started',
  'run.resumed',
  'run.status',
  'run.completed',
  'run.failed',
  'run.cancelled',
  'run.interrupted',
]);

/** Events that change an execution summary (tasks counts, paused, status). */
export function changesExecutions(type: string): boolean {
  return (
    RUN_LIFECYCLE.has(type) ||
    type.startsWith('plan.') ||
    type.startsWith('task.') ||
    type === 'handoff' ||
    type === 'run.paused' ||
    type === 'run.unpaused' ||
    type.startsWith('delegation.') ||
    type.startsWith('team.')
  );
}

export function useGlobalStream(): GlobalStreamState {
  const queryClient = useQueryClient();
  const [state, setState] = useState<GlobalStreamState>('connecting');

  useEffect(() => {
    if (typeof EventSource === 'undefined') {
      setState('unsupported');
      return;
    }
    let approvals = false;
    let runs = false;
    let executions = false;
    let timer: number | null = null;

    const flush = () => {
      timer = null;
      if (approvals) {
        void queryClient.invalidateQueries({ queryKey: qk.approvals });
      }
      if (runs) {
        void queryClient.invalidateQueries({ queryKey: [...qk.runs, 'list'] });
        void queryClient.invalidateQueries({ queryKey: qk.agents });
        void queryClient.invalidateQueries({ queryKey: [...qk.projects, 'list'] });
      }
      if (executions || approvals) {
        void queryClient.invalidateQueries({ queryKey: qk.executions });
      }
      if (approvals || runs) void queryClient.invalidateQueries({ queryKey: qk.dashboard });
      approvals = false;
      runs = false;
      executions = false;
    };

    const source = new EventSource(GLOBAL_STREAM_URL, { withCredentials: true });
    source.onopen = () => setState('open');
    source.onerror = () => setState(source.readyState === EventSource.CLOSED ? 'closed' : 'reconnecting');
    source.onmessage = (message: MessageEvent<string>) => {
      let event: RunEvent;
      try {
        event = JSON.parse(message.data) as RunEvent;
      } catch {
        return;
      }
      if (event.type.startsWith('approval.')) approvals = true;
      if (RUN_LIFECYCLE.has(event.type)) runs = true;
      if (changesExecutions(event.type)) executions = true;
      if ((approvals || runs || executions) && timer === null) timer = window.setTimeout(flush, FLUSH_MS);
    };
    return () => {
      source.close();
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [queryClient]);

  return state;
}
