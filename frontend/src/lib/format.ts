// Formatting helpers. Timestamps from the API are ISO 8601; some are read back from
// SQLite without an offset, and those are UTC.

const HAS_OFFSET = /(Z|[+-]\d{2}:?\d{2})$/i;

export function parseTs(value: string | null | undefined): Date | null {
  if (!value) return null;
  const normalized = HAS_OFFSET.test(value) ? value : `${value}Z`;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatDateTime(value: string | null | undefined): string {
  const date = parseTs(value);
  if (!date) return '—';
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function formatTime(value: string | null | undefined): string {
  const date = parseTs(value);
  if (!date) return '—';
  return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function formatRelative(value: string | null | undefined, now: number = Date.now()): string {
  const date = parseTs(value);
  if (!date) return '—';
  const seconds = Math.round((now - date.getTime()) / 1000);
  const abs = Math.abs(seconds);
  const suffix = seconds >= 0 ? 'ago' : 'from now';
  if (abs < 45) return seconds >= 0 ? 'just now' : 'in a few seconds';
  if (abs < 3600) return `${Math.round(abs / 60)} min ${suffix}`;
  if (abs < 86400) return `${Math.round(abs / 3600)} h ${suffix}`;
  if (abs < 86400 * 30) return `${Math.round(abs / 86400)} d ${suffix}`;
  return formatDateTime(value);
}

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || Number.isNaN(seconds)) return '—';
  if (seconds < 1) return `${Math.max(0, Math.round(seconds * 1000))} ms`;
  if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  if (minutes < 60) return `${minutes}m ${rest.toString().padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${(minutes % 60).toString().padStart(2, '0')}m`;
}

export function formatMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  return formatDuration(ms / 1000);
}

export function formatCost(usd: number | null | undefined): string {
  if (usd === null || usd === undefined) return '—';
  if (usd === 0) return '$0.00';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

export function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return value.toLocaleString();
}

export function formatTokens(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(2)}M`;
}

export function formatPercent(rate: number | null | undefined): string {
  if (rate === null || rate === undefined) return '—';
  return `${Math.round(rate * 1000) / 10}%`;
}

export function shortId(id: string | null | undefined, length = 8): string {
  if (!id) return '—';
  return id.length > length ? id.slice(0, length) : id;
}

export function pretty(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

export function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

/** Seconds elapsed for a run: finished runs use their duration, active runs tick against `now`. */
export function elapsedSeconds(
  run: { started_at: string | null; finished_at: string | null; duration_s: number | null },
  now: number,
): number | null {
  if (run.duration_s !== null && run.finished_at) return run.duration_s;
  const started = parseTs(run.started_at);
  if (!started) return null;
  const end = parseTs(run.finished_at)?.getTime() ?? now;
  return Math.max(0, (end - started.getTime()) / 1000);
}
