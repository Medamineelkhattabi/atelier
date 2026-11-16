// JSON text validation for the editors (run input, scripts, settings, agent definitions).

export type JsonKind = 'object' | 'array' | 'any';

export type ParseResult<T = unknown> =
  | { ok: true; value: T | undefined; empty: boolean }
  | { ok: false; error: string };

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return typeof value === 'object' ? 'an object' : `a ${typeof value}`;
}

export function parseJson<T = unknown>(
  text: string,
  kind: JsonKind = 'any',
  { allowEmpty = true }: { allowEmpty?: boolean } = {},
): ParseResult<T> {
  if (!text.trim()) {
    return allowEmpty ? { ok: true, value: undefined, empty: true } : { ok: false, error: 'A value is required.' };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `Invalid JSON: ${message}` };
  }
  if (kind === 'object' && (value === null || typeof value !== 'object' || Array.isArray(value))) {
    return { ok: false, error: `Expected a JSON object ({...}), got ${describe(value)}.` };
  }
  if (kind === 'array' && !Array.isArray(value)) {
    return { ok: false, error: `Expected a JSON array ([...]), got ${describe(value)}.` };
  }
  return { ok: true, value: value as T, empty: false };
}

/** Validates a scripted-provider script: an array of objects (one entry per model call). */
export function parseScript(text: string): ParseResult<Record<string, unknown>[]> {
  const result = parseJson<unknown[]>(text, 'array', { allowEmpty: false });
  if (!result.ok) return result;
  const entries = result.value ?? [];
  if (entries.length === 0) return { ok: false, error: 'The script needs at least one entry.' };
  const bad = entries.findIndex((entry) => entry === null || typeof entry !== 'object' || Array.isArray(entry));
  if (bad >= 0) return { ok: false, error: `Entry ${bad + 1} must be an object like {"text": "..."}.` };
  return { ok: true, value: entries as Record<string, unknown>[], empty: false };
}

/** Validates per-agent scripts: {"agent-id": [entries...]}. Empty is allowed. */
export function parseScriptMap(text: string): ParseResult<Record<string, Record<string, unknown>[]>> {
  const result = parseJson<Record<string, unknown>>(text, 'object');
  if (!result.ok || result.empty) return result as ParseResult<Record<string, Record<string, unknown>[]>>;
  for (const [agent, entries] of Object.entries(result.value ?? {})) {
    if (!Array.isArray(entries) || entries.some((e) => e === null || typeof e !== 'object' || Array.isArray(e))) {
      return { ok: false, error: `"${agent}" must map to an array of script entries.` };
    }
  }
  return result as ParseResult<Record<string, Record<string, unknown>[]>>;
}

export function stringify(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? '';
}
