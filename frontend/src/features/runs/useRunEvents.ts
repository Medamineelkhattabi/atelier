// Live events of one run tree.
// While the tree is active: EventSource on /api/runs/{root}/stream (replays history, then live;
// the browser reconnects with Last-Event-ID). When it is not active: one GET /events.
// Events are deduplicated by id and kept in id order.

import { useCallback, useEffect, useRef, useState } from 'react';
import { getRunEvents, runStreamUrl } from '../../api/endpoints';
import type { RunEvent } from '../../api/types';
import { mergeEvents } from './timelineModel';

export type ConnectionState = 'idle' | 'loading' | 'connecting' | 'open' | 'reconnecting' | 'closed' | 'unsupported';

export interface RunEventsState {
  events: RunEvent[];
  connection: ConnectionState;
  error: unknown;
  /** Opens a fresh stream (after a closed connection) or re-reads the history. */
  reconnect: () => void;
}

const FLUSH_MS = 60;

export function useRunEvents(
  rootRunId: string | undefined,
  live: boolean,
  onEvents?: (batch: RunEvent[]) => void,
): RunEventsState {
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [connection, setConnection] = useState<ConnectionState>('idle');
  const [error, setError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);
  const lastId = useRef(0);
  const pending = useRef<RunEvent[]>([]);
  const timer = useRef<number | null>(null);
  const callback = useRef(onEvents);
  callback.current = onEvents;

  const flush = useCallback(() => {
    timer.current = null;
    const batch = pending.current;
    pending.current = [];
    if (batch.length === 0) return;
    setEvents((current) => mergeEvents(current, batch));
    callback.current?.(batch);
  }, []);

  const push = useCallback(
    (batch: RunEvent[]) => {
      for (const event of batch) if (event.id > lastId.current) lastId.current = event.id;
      pending.current.push(...batch);
      if (timer.current === null) timer.current = window.setTimeout(flush, FLUSH_MS);
    },
    [flush],
  );

  // A different tree starts from scratch.
  useEffect(() => {
    setEvents([]);
    setError(null);
    lastId.current = 0;
    pending.current = [];
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = null;
    };
  }, [rootRunId]);

  // Live stream while the tree is active.
  useEffect(() => {
    if (!rootRunId || !live) return;
    if (typeof EventSource === 'undefined') {
      setConnection('unsupported');
      return;
    }
    setConnection('connecting');
    const source = new EventSource(runStreamUrl(rootRunId, lastId.current), { withCredentials: true });
    source.onopen = () => {
      setConnection('open');
      setError(null);
    };
    source.onmessage = (message: MessageEvent<string>) => {
      try {
        push([JSON.parse(message.data) as RunEvent]);
      } catch {
        // Ignore a malformed frame; the next reconnect replays from the database.
      }
    };
    source.onerror = () => {
      if (source.readyState === EventSource.CLOSED) {
        setConnection('closed');
        // The stream was refused (expired session, deleted run...): read what is stored.
        getRunEvents(rootRunId, lastId.current).then(
          (response) => push(response.events),
          (err: unknown) => setError(err),
        );
      } else {
        setConnection('reconnecting');
      }
    };
    return () => source.close();
  }, [rootRunId, live, attempt, push]);

  // History only, when the tree is not active (and to catch trailing events after it ends).
  useEffect(() => {
    if (!rootRunId || live) return;
    let cancelled = false;
    setConnection('loading');
    getRunEvents(rootRunId, lastId.current).then(
      (response) => {
        if (cancelled) return;
        push(response.events);
        setConnection('idle');
      },
      (err: unknown) => {
        if (cancelled) return;
        setError(err);
        setConnection('closed');
      },
    );
    return () => {
      cancelled = true;
    };
  }, [rootRunId, live, attempt, push]);

  const reconnect = useCallback(() => setAttempt((value) => value + 1), []);

  return { events, connection, error, reconnect };
}
