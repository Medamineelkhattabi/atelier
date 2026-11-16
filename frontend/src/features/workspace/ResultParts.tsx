// Plain rendering of what a team member reported: outcome, summary, answer, problems, and the full
// result as readable labels and values. Raw JSON only appears inside "Technical details".

import { createContext, useContext, useState, type ReactNode } from 'react';
import { CircleCheck, CircleX } from 'lucide-react';
import { Badge, Disclosure, JsonBlock } from '../../components/ui';
import { cx } from '../../lib/cx';
import { Markdown, looksLikeMarkdown, shortenText } from '../../lib/markdown';
import { OUTCOME_LABEL, VERDICT_LABEL, type ChangeFacts, type Finding, type PlainReport } from '../../lib/plain';

export function OutcomeBadge({ outcome }: { outcome: PlainReport['outcome'] }) {
  if (!outcome) return null;
  const info = OUTCOME_LABEL[outcome];
  return (
    <Badge tone={info.tone} dot title={info.hint}>
      {info.label}
    </Badge>
  );
}

/** What a security review decided about the change. */
export function VerdictBadge({ verdict }: { verdict: keyof typeof VERDICT_LABEL | null | undefined }) {
  if (!verdict) return null;
  const info = VERDICT_LABEL[verdict];
  return (
    <Badge tone={info.tone} dot title={info.hint}>
      {info.label}
    </Badge>
  );
}

const SEVERITY_TONE = { critical: 'red', high: 'red', medium: 'amber', low: 'gray' } as const;

/** A security review's findings at first glance: how serious, what, where, and the fix. */
export function FindingList({ findings }: { findings: Finding[] }) {
  if (findings.length === 0) return null;
  return (
    <ul className="space-y-2" aria-label="What the review found">
      {findings.map((finding, index) => (
        <li key={`${index}-${finding.where}`} className="rounded-md border border-zinc-200 px-3 py-2 dark:border-zinc-800">
          <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-zinc-900 dark:text-zinc-100">
            {finding.severity && (
              <Badge tone={SEVERITY_TONE[finding.severity as keyof typeof SEVERITY_TONE] ?? 'gray'}>
                {finding.severity.charAt(0).toUpperCase() + finding.severity.slice(1)}
              </Badge>
            )}
            <span className="min-w-0 break-words">{finding.issue}</span>
          </p>
          {finding.where && <p className="mt-1 break-all font-mono text-xs text-zinc-600 dark:text-zinc-400">{finding.where}</p>}
          {finding.fix && (
            <p className="mt-1 break-words text-sm text-zinc-800 dark:text-zinc-200">
              <span className="font-medium">Fix:</span> {finding.fix}
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}

const FILES_SHOWN = 8;

/** A code change at first glance: the files it touched and whether its own check passed. */
export function ChangeFactsLines({ facts }: { facts: ChangeFacts }) {
  const more = facts.files.length - FILES_SHOWN;
  return (
    <dl className="space-y-1 text-sm">
      {facts.files.length > 0 && (
        <div className="flex flex-wrap items-baseline gap-x-2">
          <dt className="shrink-0 text-zinc-600 dark:text-zinc-400">{facts.files.length === 1 ? 'File changed' : `${facts.files.length} files changed`}</dt>
          <dd className="min-w-0 break-all font-mono text-xs leading-5 text-zinc-800 dark:text-zinc-200">
            {facts.files.slice(0, FILES_SHOWN).join(', ')}
            {more > 0 && <span className="font-sans text-zinc-500 dark:text-zinc-400"> and {more} more</span>}
          </dd>
        </div>
      )}
      {facts.check && (
        <div className="flex flex-wrap items-center gap-x-2">
          <dt className="shrink-0 text-zinc-600 dark:text-zinc-400">Check</dt>
          <dd className={cx('flex min-w-0 flex-wrap items-center gap-x-1.5', facts.check.passed ? 'text-zinc-800 dark:text-zinc-200' : 'font-medium text-red-700 dark:text-red-400')}>
            {facts.check.passed ? (
              <CircleCheck className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />
            ) : (
              <CircleX className="h-4 w-4 shrink-0" aria-hidden />
            )}
            <span>{facts.check.passed ? 'Passed' : 'Did not pass'}</span>
            {(facts.check.result || facts.check.command) && (
              <span className="min-w-0 break-words font-normal text-zinc-600 dark:text-zinc-400">
                {[facts.check.result, facts.check.command && `(${facts.check.command})`].filter(Boolean).join(' ')}
              </span>
            )}
          </dd>
        </div>
      )}
    </dl>
  );
}

/** Long text is shortened, with a button to read everything. */
export function Prose({ text, limit = 600, className }: { text: string; limit?: number; className?: string }) {
  const [all, setAll] = useState(false);
  const long = text.length > limit + 100;
  return (
    <div className={className}>
      <Markdown text={long && !all ? shortenText(text, limit) : text} />
      {long && (
        <button
          type="button"
          onClick={() => setAll((v) => !v)}
          className="mt-1 rounded text-xs font-medium text-accent-700 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 dark:text-accent-300"
        >
          {all ? 'Show less' : 'Read everything'}
        </button>
      )}
    </div>
  );
}

export function IssueList({ issues, label = 'What is missing or uncertain' }: { issues: string[]; label?: string }) {
  if (issues.length === 0) return null;
  return (
    <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 dark:border-amber-900 dark:bg-amber-950/40">
      <p className="text-xs font-semibold text-amber-900 dark:text-amber-200">{label}</p>
      <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-amber-900 dark:text-amber-100" aria-label={label}>
        {issues.map((issue, index) => (
          <li key={`${index}-${issue}`} className="break-words">
            {issue}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** "files_written" -> "Files written". */
export function humanizeKey(key: string): string {
  const text = key.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim().toLowerCase();
  return text.replace(/^\w/, (c) => c.toUpperCase());
}

/** Team member names (id -> name), so results show "Researcher" rather than "research". */
const NamesContext = createContext<Record<string, { name?: string }>>({});
/** Internal identifiers that mean nothing to the owner; they stay in the technical details. */
const HIDDEN_KEYS = new Set(['task_id', 'run_id', 'child_run_id', 'plan_id', 'tool_call_id']);
/** Keys whose values are team member ids. */
const MEMBER_KEYS = new Set(['agent', 'agent_id', 'by', 'suggested_agent', 'to_agent', 'from_agent']);

const isPrimitive = (value: unknown) => value === null || ['string', 'number', 'boolean'].includes(typeof value);

/** Any JSON value as readable labels, lists and text (no braces or quotes). */
export function Readable({ value, depth = 0 }: { value: unknown; depth?: number }): ReactNode {
  if (value === null || value === undefined || value === '') return <span className="text-zinc-500 dark:text-zinc-400">None</span>;
  if (typeof value === 'string')
    return looksLikeMarkdown(value) || value.includes('\n') ? <Markdown text={value} /> : <span className="whitespace-pre-wrap break-words">{value}</span>;
  if (typeof value === 'number' || typeof value === 'boolean') return <span>{value === true ? 'Yes' : value === false ? 'No' : String(value)}</span>;
  if (depth > 4) return <span className="break-words font-mono text-xs">{JSON.stringify(value)}</span>;
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="text-zinc-500 dark:text-zinc-400">None</span>;
    if (value.every(isPrimitive)) {
      return (
        <ul className="list-disc space-y-0.5 pl-5">
          {value.map((item, index) => (
            <li key={index}>
              <Readable value={item} depth={depth + 1} />
            </li>
          ))}
        </ul>
      );
    }
    return (
      <ol className="space-y-2">
        {value.map((item, index) => (
          <li key={index} className="rounded-md border border-zinc-200 px-3 py-2 dark:border-zinc-800">
            <Readable value={item} depth={depth + 1} />
          </li>
        ))}
      </ol>
    );
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(([key]) => !HIDDEN_KEYS.has(key));
    if (entries.length === 0) return <span className="text-zinc-500 dark:text-zinc-400">None</span>;
    return (
      <dl className="space-y-2">
        {entries.map(([key, item]) => (
          <div key={key} className="min-w-0">
            <dt className="text-xs font-semibold text-zinc-600 dark:text-zinc-400">{humanizeKey(key)}</dt>
            <dd className="mt-0.5 min-w-0 break-words text-sm text-zinc-800 dark:text-zinc-200">
              {MEMBER_KEYS.has(key) && typeof item === 'string' ? <MemberValue id={item} /> : <Readable value={item} depth={depth + 1} />}
            </dd>
          </div>
        ))}
      </dl>
    );
  }
  return <span>{String(value)}</span>;
}

function MemberValue({ id }: { id: string }) {
  const names = useContext(NamesContext);
  return <span>{names[id]?.name ?? id}</span>;
}

/** Outcome, summary and problems: what a step card or the final result shows at first glance. */
export function ReportGlance({ report, showAnswer = false, className }: { report: PlainReport; showAnswer?: boolean; className?: string }) {
  return (
    <div className={cx('space-y-2', className)}>
      {report.outcome && <OutcomeBadge outcome={report.outcome} />}
      {report.summary && <Prose text={report.summary} limit={400} />}
      {(showAnswer || !report.summary) && report.answer && <Prose text={report.answer} limit={showAnswer ? 1200 : 400} />}
      <IssueList issues={report.issues} />
    </div>
  );
}

/** Everything a team member reported, readable; the raw data only in a technical disclosure. */
export function FullReport({
  report,
  raw,
  answerShown = false,
  names = {},
}: {
  report: PlainReport;
  raw: unknown;
  answerShown?: boolean;
  /** Team member names, to show names instead of ids. */
  names?: Record<string, { name?: string }>;
}) {
  const answer = !answerShown && report.answer ? report.answer : '';
  return (
    <NamesContext.Provider value={names}>
    <div className="space-y-3 text-sm">
      {answer && <Prose text={answer} limit={4000} />}
      {report.details && <Readable value={report.details} />}
      {!answer && !report.details && <p className="text-zinc-500 dark:text-zinc-400">Nothing else was reported.</p>}
      {raw !== null && raw !== undefined && typeof raw === 'object' && (
        <Disclosure summary="Technical details (raw data)">
          <JsonBlock value={raw} maxHeight="max-h-72" copy />
        </Disclosure>
      )}
    </div>
    </NamesContext.Provider>
  );
}
