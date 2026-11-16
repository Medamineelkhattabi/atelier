// Safe Markdown display for what team members write (results, summaries, documents).
//
// Team members answer in Markdown: headings, bold, lists, tables, code. Showing the raw symbols
// (#, **, |---|) confuses people, so this renders the common subset as real formatting.
// It builds React elements only (never HTML strings), so nothing in a result can inject markup or
// scripts; links are kept only for http(s) and mailto addresses and open in a new tab.

import { Fragment, type ReactNode } from 'react';
import { cx } from './cx';

// ------------------------------------------------------------------ inline

const INLINE =
  /(`+)([\s\S]*?[^`])\1(?!`)|\*\*(?=\S)([\s\S]*?\S)\*\*|__(?=\S)([\s\S]*?\S)__|\*(?=[^\s*])([^*]*?[^\s*])\*|(?<![\w])_(?=[^\s_])([^_]*?[^\s_])_(?![\w])|\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

const SAFE_LINK = /^(https?:\/\/|mailto:)/i;

function inline(text: string, key = 'i'): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  for (const m of text.matchAll(INLINE)) {
    const start = m.index ?? 0;
    if (start > last) out.push(text.slice(last, start));
    const k = `${key}-${n++}`;
    if (m[2] !== undefined) {
      out.push(
        <code key={k} className="rounded bg-zinc-100 px-1 py-0.5 font-mono text-[0.85em] text-zinc-800 dark:bg-zinc-800 dark:text-zinc-200">
          {m[2]}
        </code>,
      );
    } else if (m[3] !== undefined || m[4] !== undefined) {
      out.push(
        <strong key={k} className="font-semibold">
          {inline(m[3] ?? m[4]!, k)}
        </strong>,
      );
    } else if (m[5] !== undefined || m[6] !== undefined) {
      out.push(<em key={k}>{inline(m[5] ?? m[6]!, k)}</em>);
    } else if (m[7] !== undefined) {
      const url = m[8]!;
      out.push(
        SAFE_LINK.test(url) ? (
          <a key={k} href={url} target="_blank" rel="noopener noreferrer nofollow" className="font-medium text-accent-700 underline dark:text-accent-300">
            {inline(m[7], k)}
          </a>
        ) : (
          <Fragment key={k}>{`${m[7]} (${url})`}</Fragment>
        ),
      );
    }
    last = start + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Lines joined with visible line breaks (team members often break lines on purpose). */
function lines(parts: string[], key: string): ReactNode[] {
  return parts.flatMap((line, index) => (index === 0 ? inline(line, `${key}-${index}`) : [<br key={`${key}-br${index}`} />, ...inline(line, `${key}-${index}`)]));
}

// ------------------------------------------------------------------ blocks

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const FENCE = /^\s*(```|~~~)/;
const BULLET = /^(\s*)([-*+])\s+(.*)$/;
const NUMBERED = /^(\s*)(\d{1,9})[.)]\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function cells(row: string): string[] {
  let text = row.trim();
  if (text.startsWith('|')) text = text.slice(1);
  if (text.endsWith('|') && !text.endsWith('\\|')) text = text.slice(0, -1);
  return text.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, '|'));
}

const isListLine = (line: string) => BULLET.test(line) || NUMBERED.test(line);

interface Item {
  indent: number;
  ordered: boolean;
  start: number;
  text: string[];
}

function renderList(items: Item[], key: string): ReactNode {
  const base = items[0]!.indent;
  const groups: { item: Item; children: Item[] }[] = [];
  for (const item of items) {
    if (item.indent > base && groups.length) groups[groups.length - 1]!.children.push(item);
    else groups.push({ item, children: [] });
  }
  const ordered = items[0]!.ordered;
  const Tag = ordered ? 'ol' : 'ul';
  return (
    <Tag key={key} start={ordered && items[0]!.start !== 1 ? items[0]!.start : undefined} className={cx('space-y-1 pl-5', ordered ? 'list-decimal' : 'list-disc')}>
      {groups.map(({ item, children }, index) => (
        <li key={`${key}-${index}`}>
          {lines(item.text, `${key}-${index}`)}
          {children.length > 0 && <div className="mt-1">{renderList(children, `${key}-${index}-sub`)}</div>}
        </li>
      ))}
    </Tag>
  );
}

function blocks(source: string, key = 'b'): ReactNode[] {
  const all = source.replace(/\r\n?/g, '\n').split('\n');
  const out: ReactNode[] = [];
  let i = 0;
  let n = 0;
  const next = () => `${key}-${n++}`;
  while (i < all.length) {
    const line = all[i]!;
    if (!line.trim()) {
      i += 1;
      continue;
    }
    const fence = line.match(FENCE);
    if (fence) {
      const code: string[] = [];
      i += 1;
      while (i < all.length && !all[i]!.trim().startsWith(fence[1]!)) code.push(all[i++]!);
      i += 1;
      out.push(
        <pre key={next()} className="overflow-x-auto rounded-md bg-zinc-100 p-3 font-mono text-xs leading-relaxed text-zinc-800 dark:bg-zinc-950 dark:text-zinc-200">
          <code>{code.join('\n')}</code>
        </pre>,
      );
      continue;
    }
    const heading = line.match(HEADING);
    if (heading) {
      const level = heading[1]!.length;
      const Tag = (['h3', 'h4', 'h5', 'h6', 'h6', 'h6'] as const)[level - 1]!;
      const size = level === 1 ? 'text-lg' : level === 2 ? 'text-base' : 'text-sm';
      out.push(
        <Tag key={next()} className={cx('font-semibold text-zinc-900 dark:text-zinc-50', size)}>
          {inline(heading[2]!, `${key}-h${n}`)}
        </Tag>,
      );
      i += 1;
      continue;
    }
    if (RULE.test(line)) {
      out.push(<hr key={next()} className="border-zinc-200 dark:border-zinc-800" />);
      i += 1;
      continue;
    }
    if (line.includes('|') && i + 1 < all.length && TABLE_SEPARATOR.test(all[i + 1]!)) {
      const header = cells(line);
      const rows: string[][] = [];
      i += 2;
      while (i < all.length && all[i]!.includes('|') && all[i]!.trim()) rows.push(cells(all[i++]!));
      const k = next();
      out.push(
        <div key={k} className="overflow-x-auto rounded-md border border-zinc-200 dark:border-zinc-800">
          <table className="min-w-full border-collapse text-left text-sm">
            <thead className="bg-zinc-50 dark:bg-zinc-900">
              <tr>
                {header.map((cell, c) => (
                  <th key={c} scope="col" className="border-b border-zinc-200 px-3 py-2 font-semibold text-zinc-900 dark:border-zinc-800 dark:text-zinc-100">
                    {inline(cell, `${k}-th${c}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, r) => (
                <tr key={r} className="border-b border-zinc-100 last:border-0 dark:border-zinc-800">
                  {header.map((_, c) => (
                    <td key={c} className="px-3 py-2 align-top text-zinc-800 dark:text-zinc-200">
                      {inline(row[c] ?? '', `${k}-${r}-${c}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    if (QUOTE.test(line)) {
      const quoted: string[] = [];
      while (i < all.length && QUOTE.test(all[i]!)) quoted.push(all[i++]!.match(QUOTE)![1]!);
      out.push(
        <blockquote key={next()} className="space-y-2 border-l-2 border-zinc-300 pl-3 text-zinc-700 dark:border-zinc-700 dark:text-zinc-300">
          {blocks(quoted.join('\n'), `${key}-q${n}`)}
        </blockquote>,
      );
      continue;
    }
    if (isListLine(line)) {
      const items: Item[] = [];
      while (i < all.length) {
        const current = all[i]!;
        const bullet = current.match(BULLET);
        const numbered = current.match(NUMBERED);
        if (bullet || numbered) {
          const m = (bullet ?? numbered)!;
          items.push({ indent: m[1]!.replace(/\t/g, '    ').length, ordered: !!numbered, start: numbered ? Number(numbered[2]) : 1, text: [m[3]!] });
          i += 1;
        } else if (current.trim() && /^\s{2,}\S/.test(current) && items.length) {
          items[items.length - 1]!.text.push(current.trim());
          i += 1;
        } else break;
      }
      out.push(renderList(items, next()));
      continue;
    }
    const paragraph: string[] = [];
    while (i < all.length) {
      const current = all[i]!;
      if (!current.trim() || FENCE.test(current) || HEADING.test(current) || RULE.test(current) || QUOTE.test(current) || isListLine(current)) break;
      if (current.includes('|') && i + 1 < all.length && TABLE_SEPARATOR.test(all[i + 1]!)) break;
      paragraph.push(current.trim());
      i += 1;
    }
    out.push(
      <p key={next()} className="break-words">
        {lines(paragraph, `${key}-p${n}`)}
      </p>,
    );
  }
  return out;
}

/** True when the text uses Markdown worth rendering (otherwise plain text is shown as is). */
export function looksLikeMarkdown(text: string): boolean {
  return /(^|\n)\s*(#{1,6}\s|[-*+]\s|\d+[.)]\s|>\s|```|\|.*\|)|\*\*\S|`[^`]+`|\[[^\]]+\]\(/.test(text);
}

/** Text written by a team member, with its Markdown shown as real formatting. */
export function Markdown({ text, className }: { text: string; className?: string }) {
  return <div className={cx('min-w-0 space-y-2 text-sm leading-relaxed text-zinc-800 dark:text-zinc-200', className)}>{blocks(text)}</div>;
}

/** A shortened version that ends on a whole line, for previews with "Read everything". */
export function shortenText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const lineEnd = cut.lastIndexOf('\n');
  const wordEnd = cut.lastIndexOf(' ');
  const end = lineEnd > limit * 0.6 ? lineEnd : wordEnd > limit * 0.6 ? wordEnd : limit;
  return `${text.slice(0, end).trimEnd()}…`;
}
