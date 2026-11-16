// Small typed fetch client.
// - Every call is relative (/api/...): in production the backend serves this app (same origin).
// - Every non-GET request carries the session's CSRF token in X-CSRF-Token.
// - Errors are thrown as ApiError with the server's `detail` as the message.

import type { ValidationIssue } from './types';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

let csrfToken: string | null = null;
let unauthorizedHandler: (() => void) | null = null;

export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

export function getCsrfToken(): string | null {
  return csrfToken;
}

/** Called when an authenticated request comes back 401 (session expired or signed out elsewhere). */
export function onUnauthorized(handler: (() => void) | null): void {
  unauthorizedHandler = handler;
}

export class ApiError extends Error {
  readonly status: number;
  readonly detail: unknown;

  constructor(status: number, message: string, detail: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.detail = detail;
  }
}

function isValidationIssue(value: unknown): value is ValidationIssue {
  return typeof value === 'object' && value !== null && 'msg' in value && 'loc' in value;
}

/** Turns FastAPI's `detail` (string, validation list or object) into one readable message. */
export function formatDetail(detail: unknown, fallback: string): string {
  if (typeof detail === 'string' && detail.trim()) return detail;
  if (Array.isArray(detail) && detail.length > 0) {
    return detail
      .map((item) => {
        if (isValidationIssue(item)) {
          const loc = item.loc.filter((part) => part !== 'body').join('.');
          return loc ? `${loc}: ${item.msg}` : item.msg;
        }
        return typeof item === 'string' ? item : JSON.stringify(item);
      })
      .join('; ');
  }
  if (detail && typeof detail === 'object') return JSON.stringify(detail);
  return fallback;
}

export type QueryValue = string | number | boolean | null | undefined;

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  query?: Record<string, QueryValue>;
  signal?: AbortSignal;
}

export function buildUrl(path: string, query?: Record<string, QueryValue>): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

export async function apiFetch<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (!SAFE_METHODS.has(method) && csrfToken) headers['X-CSRF-Token'] = csrfToken;

  let response: Response;
  try {
    response = await fetch(buildUrl(path, options.query), {
      method,
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      credentials: 'same-origin',
      signal: options.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiError(0, 'Cannot reach the server. Check that the backend is running.', null);
  }

  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }

  if (!response.ok) {
    const hasDetail = payload !== null && typeof payload === 'object' && 'detail' in payload;
    const detail = hasDetail ? (payload as { detail: unknown }).detail : payload;
    const fallback = `${response.status} ${response.statusText || 'request failed'}`.trim();
    // A non-JSON body (proxy error page...) is not shown verbatim when it is long.
    const message = !hasDetail && typeof payload === 'string' && payload.length > 300
      ? fallback
      : formatDetail(detail, fallback);
    if (response.status === 401 && !path.startsWith('/api/auth/')) unauthorizedHandler?.();
    throw new ApiError(response.status, message, detail);
  }
  return payload as T;
}

export const api = {
  get: <T>(path: string, query?: Record<string, QueryValue>, signal?: AbortSignal) =>
    apiFetch<T>(path, { method: 'GET', query, signal }),
  post: <T>(path: string, body?: unknown) => apiFetch<T>(path, { method: 'POST', body: body ?? {} }),
  put: <T>(path: string, body?: unknown) => apiFetch<T>(path, { method: 'PUT', body: body ?? {} }),
  patch: <T>(path: string, body?: unknown) => apiFetch<T>(path, { method: 'PATCH', body: body ?? {} }),
  delete: <T>(path: string) => apiFetch<T>(path, { method: 'DELETE' }),
};

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}
