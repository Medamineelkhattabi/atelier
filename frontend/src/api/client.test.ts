import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiFetch, api, formatDetail, onUnauthorized, setCsrfToken } from './client';
import { mockFetch } from '../test/utils';

afterEach(() => {
  setCsrfToken(null);
  onUnauthorized(null);
});

describe('api client: CSRF header', () => {
  it('sends X-CSRF-Token on every non-GET request', async () => {
    setCsrfToken('csrf-123');
    const { calls } = mockFetch({
      'POST /api/runs': { run_id: 'r1' },
      'PATCH /api/settings': { values: {} },
      'PUT /api/secrets/X_KEY': { name: 'X_KEY', hint: '…abcd' },
      'DELETE /api/runs/r1': { deleted: 'r1' },
    });
    await api.post('/api/runs', { task: 't' });
    await api.patch('/api/settings', { 'retention.days': 30 });
    await api.put('/api/secrets/X_KEY', { value: 'v' });
    await api.delete('/api/runs/r1');
    expect(calls).toHaveLength(4);
    for (const call of calls) expect(call.headers['x-csrf-token']).toBe('csrf-123');
    expect(calls[0]!.headers['content-type']).toBe('application/json');
    expect(calls[0]!.body).toEqual({ task: 't' });
  });

  it('does not send the CSRF header on GET', async () => {
    setCsrfToken('csrf-123');
    const { calls } = mockFetch({ 'GET /api/agents': { items: [], load_errors: {} } });
    await api.get('/api/agents');
    expect(calls[0]!.headers['x-csrf-token']).toBeUndefined();
  });

  it('sends no CSRF header before a session exists (login, setup)', async () => {
    const { calls } = mockFetch({ 'POST /api/auth/login': { username: 'owner', csrf_token: 'new' } });
    await api.post('/api/auth/login', { username: 'owner', password: 'x' });
    expect(calls[0]!.headers['x-csrf-token']).toBeUndefined();
  });

  it('builds query strings and skips empty values', async () => {
    const { fn } = mockFetch({ 'GET /api/runs': { total: 0, items: [] } });
    await api.get('/api/runs', { status: 'failed', q: '', agent_id: undefined, limit: 25 });
    expect(String(fn.mock.calls[0]![0])).toBe('/api/runs?status=failed&limit=25');
  });
});

describe('api client: errors', () => {
  it('throws ApiError with the server detail and status', async () => {
    setCsrfToken('t');
    mockFetch({ 'POST /api/runs': { status: 400, body: { detail: "agent 'x' does not exist" } } });
    const error = await apiFetch('/api/runs', { method: 'POST', body: {} }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(400);
    expect((error as ApiError).message).toBe("agent 'x' does not exist");
  });

  it('formats FastAPI validation errors (422)', async () => {
    mockFetch({
      'POST /api/auth/setup': {
        status: 422,
        body: { detail: [{ loc: ['body', 'password'], msg: 'String should have at least 10 characters', type: 'string_too_short' }] },
      },
    });
    await expect(api.post('/api/auth/setup', {})).rejects.toThrow('password: String should have at least 10 characters');
  });

  it('reports a missing CSRF token rejection as the server says it', async () => {
    mockFetch({ 'POST /api/runs': { status: 403, body: { detail: 'missing or invalid CSRF token' } } });
    await expect(api.post('/api/runs', {})).rejects.toMatchObject({ status: 403, message: 'missing or invalid CSRF token' });
  });

  it('falls back to the status text when the body has no detail', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 502, statusText: 'Bad Gateway' })));
    await expect(api.get('/api/health')).rejects.toMatchObject({ status: 502, message: '502 Bad Gateway' });
  });

  it('turns a network failure into a readable ApiError', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))));
    await expect(api.get('/api/health')).rejects.toMatchObject({ status: 0 });
  });

  it('notifies the session handler on 401 outside /api/auth', async () => {
    const handler = vi.fn();
    onUnauthorized(handler);
    mockFetch({
      'GET /api/agents': { status: 401, body: { detail: 'authentication required' } },
      'POST /api/auth/login': { status: 401, body: { detail: 'invalid username or password' } },
    });
    await expect(api.get('/api/agents')).rejects.toThrow('authentication required');
    await expect(api.post('/api/auth/login', {})).rejects.toThrow('invalid username or password');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('formatDetail handles strings, lists and objects', () => {
    expect(formatDetail('plain', 'x')).toBe('plain');
    expect(formatDetail([{ loc: ['body', 'task'], msg: 'Field required', type: 'missing' }], 'x')).toBe('task: Field required');
    expect(formatDetail({ code: 1 }, 'x')).toBe('{"code":1}');
    expect(formatDetail(null, 'fallback')).toBe('fallback');
  });
});
