// Panels of the run view: run tree, final result (incl. team contributions), error.

import { Link } from 'react-router-dom';
import { CircleX, FileText, GitBranch, Users } from 'lucide-react';
import type { JsonValue, RunDetail, RunSummary } from '../../api/types';
import { Badge, Card, CardBody, CardHeader, Disclosure, JsonBlock, Mono, StatusBadge } from '../../components/ui';
import { cx } from '../../lib/cx';
import { formatCost, formatTokens } from '../../lib/format';
import { orderTree } from './timelineModel';

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

export function runTitle(run: Pick<RunSummary, 'kind' | 'agent_id' | 'team_id' | 'team_name'>): string {
  if (run.kind === 'team') return run.team_name || run.team_id || 'Team run';
  return run.agent_id ?? 'agent';
}

export function RunTreePanel({ tree, currentId }: { tree: RunSummary[]; currentId: string }) {
  const nodes = orderTree(tree);
  return (
    <Card>
      <CardHeader
        title="Run tree"
        icon={<GitBranch className="h-4 w-4" />}
        description={`${tree.length} run${tree.length === 1 ? '' : 's'}: delegations and team members`}
      />
      <ul className="divide-y divide-zinc-100 dark:divide-zinc-800" aria-label="Runs in this tree">
        {nodes.map(({ run, depth }) => {
          const current = run.id === currentId;
          return (
            <li key={run.id}>
              <Link
                to={`/runs/${run.id}`}
                aria-current={current ? 'page' : undefined}
                className={cx(
                  'flex items-start gap-2 px-4 py-2.5 text-sm hover:bg-zinc-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-500 dark:hover:bg-zinc-800/60',
                  current && 'bg-accent-50/70 dark:bg-accent-950/40',
                )}
                style={{ paddingLeft: `${1 + depth * 1.1}rem` }}
              >
                {depth > 0 && <span className="mt-0.5 text-zinc-300 dark:text-zinc-600" aria-hidden>└</span>}
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    {run.kind === 'team' ? (
                      <Users className="h-3.5 w-3.5 text-zinc-500" aria-hidden />
                    ) : null}
                    <span className="truncate font-medium text-zinc-900 dark:text-zinc-100">{runTitle(run)}</span>
                    <StatusBadge status={run.status} />
                  </div>
                  {run.role && <p className="mt-0.5 line-clamp-2 text-xs text-zinc-500 dark:text-zinc-400">{run.role}</p>}
                  <p className="mt-0.5 text-xs tabular-nums text-zinc-400">
                    <Mono className="text-[0.7rem]">{run.id.slice(0, 8)}</Mono> · {plural(run.steps, 'step')} · {plural(run.tool_calls, 'tool call')} ·{' '}
                    {formatTokens(run.input_tokens + run.output_tokens)} tok · {formatCost(run.cost_usd)}
                  </p>
                </div>
              </Link>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

function OutputView({ output, text }: { output: JsonValue | null | undefined; text: string | null | undefined }) {
  if (output !== null && output !== undefined) {
    return (
      <div className="space-y-3">
        <JsonBlock value={output} copy maxHeight="max-h-[32rem]" />
        {text && (
          <Disclosure summary="Text that accompanied the structured output">
            <p className="whitespace-pre-wrap text-sm text-zinc-800 dark:text-zinc-200">{text}</p>
          </Disclosure>
        )}
      </div>
    );
  }
  if (text) {
    return <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-zinc-800 dark:text-zinc-200">{text}</p>;
  }
  return <p className="text-sm text-zinc-500">The run produced no output.</p>;
}

interface Contribution {
  agent: string;
  responsibility?: string;
  run_id?: string;
  status?: string;
  output?: JsonValue | null;
  output_text?: string | null;
  error?: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Team runs return {mode, contributions[], result}; anything else is shown as-is. */
function teamOutput(output: JsonValue | null): { mode: string; contributions: Contribution[]; result: JsonValue | null } | null {
  if (!isRecord(output) || !Array.isArray(output.contributions)) return null;
  const contributions = (output.contributions as unknown[]).filter(isRecord).map((c) => c as unknown as Contribution);
  return { mode: String(output.mode ?? ''), contributions, result: (output.result ?? null) as JsonValue | null };
}

export function ResultPanel({ run }: { run: RunDetail }) {
  const team = run.kind === 'team' ? teamOutput(run.output) : null;
  if (team) {
    const consolidated = team.mode === 'parallel' && run.team?.consolidator;
    return (
      <Card>
        <CardHeader
          title={consolidated ? 'Consolidated result' : 'Team result'}
          icon={<FileText className="h-4 w-4" />}
          description={`Mode: ${team.mode}. ${team.contributions.length} contribution${team.contributions.length === 1 ? '' : 's'}.`}
        />
        <CardBody className="space-y-4">
          {team.result !== null ? (
            <OutputView output={team.result} text={run.output_text} />
          ) : (
            <OutputView output={null} text={run.output_text} />
          )}
          <div>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
              Per-member contributions
            </h3>
            <ol className="space-y-2">
              {team.contributions.map((c, index) => (
                <li key={`${c.agent}-${c.run_id ?? index}`} className="rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs tabular-nums text-zinc-400">#{index + 1}</span>
                    <Mono className="font-semibold text-zinc-900 dark:text-zinc-100">{c.agent}</Mono>
                    {c.status && <StatusBadge status={c.status} />}
                    {c.run_id && (
                      <Link to={`/runs/${c.run_id}`} className="ml-auto text-xs font-medium text-accent-700 hover:underline dark:text-accent-300">
                        Open member run
                      </Link>
                    )}
                  </div>
                  {c.responsibility && <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{c.responsibility}</p>}
                  {c.error && <p className="mt-1 text-sm text-red-700 dark:text-red-300">{c.error}</p>}
                  <Disclosure summary="Contribution" className="mt-2" defaultOpen={team.contributions.length <= 2}>
                    <OutputView output={c.output} text={c.output_text} />
                  </Disclosure>
                </li>
              ))}
            </ol>
          </div>
        </CardBody>
      </Card>
    );
  }
  return (
    <Card>
      <CardHeader
        title="Final result"
        icon={<FileText className="h-4 w-4" />}
        description={run.output !== null && run.output !== undefined ? 'Structured output (validated against the agent schema)' : 'Text output'}
      />
      <CardBody>
        <OutputView output={run.output} text={run.output_text} />
      </CardBody>
    </Card>
  );
}

export function ErrorPanel({ run, code }: { run: RunDetail; code?: string }) {
  if (!run.error) return null;
  const tone = run.status === 'failed' ? 'red' : 'slate';
  return (
    <section
      role={run.status === 'failed' ? 'alert' : undefined}
      className={cx(
        'rounded-lg border p-4',
        tone === 'red'
          ? 'border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950/40'
          : 'border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-900',
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <CircleX className={cx('h-4 w-4', tone === 'red' ? 'text-red-600' : 'text-slate-500')} aria-hidden />
        <h2 className={cx('text-sm font-semibold', tone === 'red' ? 'text-red-900 dark:text-red-200' : 'text-slate-800 dark:text-slate-200')}>
          {run.status === 'failed' ? 'The run failed' : run.status === 'interrupted' ? 'The run was interrupted' : 'Run ended'}
        </h2>
        {code && <Badge tone={tone === 'red' ? 'red' : 'slate'}>{code}</Badge>}
      </div>
      <p className={cx('mt-2 whitespace-pre-wrap break-words font-mono text-xs', tone === 'red' ? 'text-red-800 dark:text-red-200' : 'text-slate-700 dark:text-slate-300')}>
        {run.error}
      </p>
    </section>
  );
}
