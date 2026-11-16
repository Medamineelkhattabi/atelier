// Test helpers: providers around a component and a fetch mock routed by method + path.

import type { ReactElement, ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { vi } from 'vitest';
import type { RunEvent } from '../api/types';

export function renderWithProviders(ui: ReactElement, { route = '/' }: { route?: string } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[route]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        {children}
      </MemoryRouter>
    </QueryClientProvider>
  );
  return { client, ...render(ui, { wrapper }) };
}

export interface RecordedCall {
  method: string;
  path: string;
  /** Query string parameters of the request. */
  query: Record<string, string>;
  headers: Record<string, string>;
  body: unknown;
}

/** `{status: <number>, body}` describes a full response (e.g. an error); anything else is a 200 body. */
function isResponseSpec(value: unknown): value is { status: number; body?: unknown } {
  return typeof value === 'object' && value !== null && typeof (value as { status?: unknown }).status === 'number' && 'body' in value;
}

type Handler = (call: RecordedCall) => { status?: number; body?: unknown } | undefined;

/** Installs a fetch mock. `routes` maps "METHOD /path" (query ignored) to a response. */
export function mockFetch(routes: Record<string, unknown | Handler>) {
  const calls: RecordedCall[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.toString(), 'http://localhost');
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const call: RecordedCall = {
      method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams.entries()),
      headers,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    const route = routes[`${method} ${url.pathname}`];
    let result: { status?: number; body?: unknown } | undefined;
    if (typeof route === 'function') result = (route as Handler)(call);
    else if (isResponseSpec(route)) result = route;
    else if (route !== undefined) result = { body: route };
    if (!result) result = { status: 404, body: { detail: `no mock for ${method} ${url.pathname}` } };
    return new Response(JSON.stringify(result.body ?? {}), {
      status: result.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fn);
  return { fn, calls };
}

let nextId = 1;
export function event(type: string, source: RunEvent['source'], data: Record<string, unknown> = {}, extra: Partial<RunEvent> = {}): RunEvent {
  const id = nextId++;
  return {
    id,
    run_id: 'run1',
    root_run_id: 'run1',
    seq: id,
    ts: '2026-11-11T10:00:00+00:00',
    type,
    source,
    data,
    ...extra,
  };
}

/** Minimal EventSource double: tests push frames with emit(); instances are kept per URL. */
export class MockEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static instances: MockEventSource[] = [];

  readonly url: string;
  readyState = MockEventSource.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(url: string | URL) {
    this.url = String(url);
    MockEventSource.instances.push(this);
  }

  open() {
    this.readyState = MockEventSource.OPEN;
    this.onopen?.(new Event('open'));
  }

  emit(data: unknown) {
    this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(data) }));
  }

  close() {
    this.readyState = MockEventSource.CLOSED;
  }

  static install() {
    MockEventSource.instances = [];
    vi.stubGlobal('EventSource', MockEventSource);
  }

  static find(fragment: string): MockEventSource | undefined {
    return [...MockEventSource.instances].reverse().find((source) => source.url.includes(fragment) && source.readyState !== MockEventSource.CLOSED);
  }
}
