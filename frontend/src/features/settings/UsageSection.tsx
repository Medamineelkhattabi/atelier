// Settings › Usage: what the team did over the last 30 days, from GET /api/dashboard.
// There is no per-token billing: usage counts against the Claude subscription's allowance.

import { useQuery } from '@tanstack/react-query';
import { getDashboard } from '../../api/endpoints';
import { qk } from '../../api/keys';
import type { DashboardResponse } from '../../api/types';
import { Alert, Card, CardBody, CardHeader, Disclosure, EmptyState, ErrorState, LoadingState } from '../../components/ui';
import { formatCost, formatNumber, formatPercent, formatTokens } from '../../lib/format';

export function UsageSection() {
  const query = useQuery({ queryKey: qk.dashboard, queryFn: () => getDashboard(30), refetchInterval: 60_000 });
  if (query.isPending) return <LoadingState label="Loading your usage…" />;
  if (query.isError) return <ErrorState error={query.error} title="Your usage could not be loaded. Try again in a moment." onRetry={() => void query.refetch()} />;
  return <Usage data={query.data} />;
}

function Figure({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="min-w-0 rounded-md border border-zinc-200 px-3 py-2 dark:border-zinc-800">
      <dt className="text-xs font-medium text-zinc-600 dark:text-zinc-400">{label}</dt>
      <dd className="mt-0.5 text-xl font-semibold tabular-nums text-zinc-900 dark:text-zinc-50">{value}</dd>
      {hint && <dd className="text-xs text-zinc-600 dark:text-zinc-400">{hint}</dd>}
    </div>
  );
}

function Usage({ data }: { data: DashboardResponse }) {
  const w = data.window;
  return (
    <div className="space-y-4">
      <Alert tone="blue" title="No per-token billing">
        Counts against your Claude plan’s limits, like claude.ai. Keep paid extra usage off in claude.ai: the platform stops before it would begin.
      </Alert>
      <Card>
        <CardHeader title={`The last ${w.days} days`} description="All projects; a task counts once." />
        <CardBody className="space-y-4">
          <dl className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Figure label="Tasks asked" value={formatNumber(w.runs)} />
            <Figure label="Done" value={formatNumber(w.completed)} />
            <Figure label="Couldn’t finish" value={formatNumber(w.failed)} />
            <Figure label="Success rate" value={formatPercent(w.success_rate)} hint="Done, out of done and couldn’t finish" />
          </dl>
          <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Figure
              label="AI text processed (tokens)"
              value={formatTokens(w.input_tokens + w.output_tokens)}
              hint={`${formatTokens(w.input_tokens)} read · ${formatTokens(w.output_tokens)} written`}
            />
            <Figure label="Right now" value={`${formatNumber(data.runs.running)} in progress`} hint={`${data.pending_approvals} waiting for your approval`} />
          </dl>
          <Disclosure summary="Pay-per-use equivalent">
            <p className="text-sm text-zinc-700 dark:text-zinc-300">
              At pay-per-use API prices this usage would cost about <span className="font-medium">{formatCost(w.cost_usd)}</span>. This is an estimate
              reported by Claude Code, for comparison only: you are not charged it.
            </p>
          </Disclosure>
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Tasks per day" description="Green: finished successfully." />
        <CardBody>
          <PerDay data={data} />
        </CardBody>
      </Card>
    </div>
  );
}

function PerDay({ data }: { data: DashboardResponse }) {
  const days = data.window.days;
  if (data.per_day.length === 0) return <EmptyState title="No task in this period" />;
  const byDate = new Map(data.per_day.map((d) => [d.date, d]));
  const today = new Date();
  const series = Array.from({ length: days }, (_, index) => {
    const date = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - (days - 1 - index)));
    const key = date.toISOString().slice(0, 10);
    const entry = byDate.get(key);
    return { date: key, runs: entry?.runs ?? 0, completed: entry?.completed ?? 0 };
  });
  const max = Math.max(1, ...series.map((d) => d.runs));
  return (
    <figure>
      <div className="flex h-32 items-end gap-[2px]" aria-hidden>
        {series.map((day) => (
          <div key={day.date} className="flex h-full min-w-0 flex-1 flex-col justify-end" title={`${day.date}: ${day.runs} tasks, ${day.completed} done`}>
            <div className="flex w-full flex-col justify-end overflow-hidden rounded-sm bg-zinc-300 dark:bg-zinc-700" style={{ height: `${(day.runs / max) * 100}%` }}>
              <div className="w-full bg-emerald-500" style={{ height: day.runs ? `${(day.completed / day.runs) * 100}%` : 0 }} />
            </div>
          </div>
        ))}
      </div>
      <figcaption className="mt-2 flex justify-between gap-2 text-xs text-zinc-600 dark:text-zinc-400">
        <span>{series[0]?.date}</span>
        <span>up to {max} a day</span>
        <span>{series[series.length - 1]?.date}</span>
      </figcaption>
      <table className="sr-only">
        <caption>Tasks per day</caption>
        <thead>
          <tr>
            <th>Day</th>
            <th>Tasks</th>
            <th>Done</th>
          </tr>
        </thead>
        <tbody>
          {series
            .filter((d) => d.runs > 0)
            .map((d) => (
              <tr key={d.date}>
                <td>{d.date}</td>
                <td>{d.runs}</td>
                <td>{d.completed}</td>
              </tr>
            ))}
        </tbody>
      </table>
    </figure>
  );
}
