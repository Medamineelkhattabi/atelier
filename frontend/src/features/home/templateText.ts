// Suggested activities pre-fill the request with text in [brackets] for the owner to replace.

/** Position of the first "[...]" (brackets included), or null. */
export function firstBracket(text: string): { start: number; end: number } | null {
  const match = /\[[^\]\n]*\]/.exec(text);
  return match ? { start: match.index, end: match.index + match[0].length } : null;
}

/** The "[...]" parts of `template` that are still in `text` unchanged. */
export function untouchedPlaceholders(text: string, template: string | null | undefined): string[] {
  if (!template) return [];
  const placeholders = template.match(/\[[^\]\n]*\]/g) ?? [];
  return placeholders.filter((p) => text.includes(p));
}
