// My AI Team: who is in the team, in short cards (name, what it does, whether it changes things and
// asks first, "Ask"). The details (when it helps, what it can do, who it works with) are on each
// profile. The owner never has to pick: the Coordinator assigns the work.

import { useId, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { MessageSquarePlus, Search, Sparkles, UserPlus, Users } from 'lucide-react';
import type { Agent } from '../api/types';
import { Page } from '../components/Page';
import { Badge, Button, ButtonLink, EmptyState, ErrorState, Input, LoadingState } from '../components/ui';
import { AgentAvatar } from '../features/workspace/agentAvatar';
import { ChangeBadges, LoadErrors, useTeamData } from '../features/team/TeamParts';
import { TEAM_FILTERS, canChange, memberAbilities, memberState, searchTeam, type TeamFilter } from '../features/team/teamText';
import { COORDINATOR_ID, INTERNAL_AGENTS, type Ability } from '../lib/plain';
import { cx } from '../lib/cx';

interface Member {
  agent: Agent;
  abilities: Ability[];
}

export function TeamPage() {
  const { agents, tools } = useTeamData();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<TeamFilter>('all');
  const searchId = useId();

  const all = useMemo(() => agents.data?.items ?? [], [agents.data]);
  const members: Member[] = useMemo(() => {
    const visible = all.filter((a) => !INTERNAL_AGENTS.has(a.id));
    // The Coordinator leads the team: shown first.
    visible.sort((a, b) => Number(b.id === COORDINATOR_ID) - Number(a.id === COORDINATOR_ID));
    return visible.map((agent) => ({ agent, abilities: memberAbilities(agent, tools.data?.items) }));
  }, [all, tools.data]);
  const internal = all.filter((a) => INTERNAL_AGENTS.has(a.id));

  const passes = (id: TeamFilter, m: Member) => id === 'all' || (id === 'changes') === canChange(m.abilities);
  const matches = searchTeam(
    members.map((m) => ({ ...m.agent, member: m })),
    query,
  )
    .map((a) => a.member)
    .filter((m) => passes(filter, m));
  const counts = Object.fromEntries(TEAM_FILTERS.map((f) => [f.id, members.filter((m) => passes(f.id, m)).length]));

  return (
    <Page
      title="My AI Team"
      description="You don’t need to pick anyone: the Coordinator assigns the work."
      help={
        <p>
          Each team member has one job and only the abilities on its profile. Changing files, running commands or contacting other services waits
          for your approval, unless you allowed it in{' '}
          <Link to="/tools" className="font-medium text-accent-700 hover:underline dark:text-accent-300">
            Tools &amp; Connections
          </Link>
          .
        </p>
      }
      actions={
        <ButtonLink to="/team/new" variant="ghost" icon={<UserPlus className="h-4 w-4" />}>
          New member (advanced)
        </ButtonLink>
      }
    >
      <div className="space-y-4">
        {agents.isPending ? (
          <LoadingState label="Loading your team…" />
        ) : agents.isError ? (
          <ErrorState
            error={agents.error}
            title="Your team could not be loaded. Check that the platform is still running, then try again."
            onRetry={() => void agents.refetch()}
          />
        ) : (
          <>
            <LoadErrors errors={agents.data.load_errors} />
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative min-w-0 max-w-md flex-1 basis-64">
                <label htmlFor={searchId} className="sr-only">
                  What do you need help with?
                </label>
                <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-zinc-400" aria-hidden />
                <Input
                  id={searchId}
                  type="search"
                  className="pl-8"
                  placeholder="What do you need help with?"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </div>
              <div className="flex flex-wrap gap-1.5" role="group" aria-label="Show">
                {TEAM_FILTERS.map((f) => (
                  <button
                    key={f.id}
                    type="button"
                    aria-pressed={filter === f.id}
                    title={f.hint}
                    onClick={() => setFilter(f.id)}
                    className={cx(
                      'inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium ring-1 ring-inset focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500',
                      filter === f.id
                        ? 'bg-accent-600 text-white ring-accent-600 dark:bg-accent-500 dark:ring-accent-500'
                        : 'bg-white text-zinc-700 ring-zinc-300 hover:bg-zinc-50 dark:bg-zinc-900 dark:text-zinc-300 dark:ring-zinc-700 dark:hover:bg-zinc-800',
                    )}
                  >
                    {f.label}
                    <span className="tabular-nums opacity-80">{counts[f.id]}</span>
                  </button>
                ))}
              </div>
              <p className="sr-only" aria-live="polite">
                {query.trim() || filter !== 'all' ? `${matches.length} team member${matches.length === 1 ? '' : 's'} shown` : ''}
              </p>
            </div>

            {members.length === 0 ? (
              <EmptyState
                icon={<Users className="h-5 w-5" />}
                title="Your team is empty"
                action={
                  <ButtonLink to="/team/new" icon={<UserPlus className="h-4 w-4" />}>
                    New member (advanced)
                  </ButtonLink>
                }
              />
            ) : matches.length === 0 ? (
              <EmptyState
                icon={<Search className="h-5 w-5" />}
                title={query.trim() ? `Nobody matches “${query.trim()}”` : 'Nobody matches this filter'}
                description="Ask the team anyway: the Coordinator finds who can help."
                action={
                  <div className="flex flex-wrap justify-center gap-2">
                    <ButtonLink to={query.trim() ? `/?task=${encodeURIComponent(query.trim())}` : '/'} variant="primary" icon={<Sparkles className="h-4 w-4" />}>
                      Ask the team
                    </ButtonLink>
                    <Button
                      onClick={() => {
                        setQuery('');
                        setFilter('all');
                      }}
                    >
                      Show everyone
                    </Button>
                  </div>
                }
              />
            ) : (
              <ul className="grid gap-3 md:grid-cols-2 2xl:grid-cols-3" aria-label="Team members">
                {matches.map((m) => (
                  <MemberCard key={m.agent.id} member={m} />
                ))}
              </ul>
            )}

            {internal.length > 0 && (
              <section aria-labelledby="behind-the-scenes" className="flex flex-wrap items-baseline gap-x-1.5 text-sm text-zinc-500 dark:text-zinc-400">
                <h2 id="behind-the-scenes" className="font-medium text-zinc-700 after:content-[':'] dark:text-zinc-300">
                  Behind the scenes
                </h2>
                <p>
                  {internal.map((a, i) => (
                    <span key={a.id}>
                      {i > 0 && ', '}
                      <Link to={`/team/${encodeURIComponent(a.id)}`} className="font-medium text-accent-700 hover:underline dark:text-accent-300">
                        {a.name}
                      </Link>
                    </span>
                  ))}{' '}
                  (works for the platform itself)
                </p>
              </section>
            )}
          </>
        )}
      </div>
    </Page>
  );
}

function MemberCard({ member }: { member: Member }) {
  const { agent, abilities } = member;
  const headingId = useId();
  const state = memberState(agent);
  const coordinator = agent.id === COORDINATOR_ID;
  const profile = `/team/${encodeURIComponent(agent.id)}`;
  const about = agent.responsibility || agent.description;

  return (
    <li className="min-w-0">
      <article
        aria-labelledby={headingId}
        className={cx(
          'flex h-full flex-wrap items-start gap-3 rounded-lg border bg-white p-4 shadow-sm dark:bg-zinc-900',
          coordinator ? 'border-accent-300 dark:border-accent-800' : 'border-zinc-200 dark:border-zinc-800',
        )}
      >
        <AgentAvatar agentId={agent.id} name={agent.name} />
        <div className="min-w-0 flex-1 basis-40">
          <h2 id={headingId} className="text-base font-semibold leading-tight text-zinc-900 dark:text-zinc-50">
            <Link to={profile} className="hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500">
              {agent.name}
            </Link>
          </h2>
          {about && (
            <p className="mt-0.5 line-clamp-2 text-sm text-zinc-600 dark:text-zinc-400" title={about}>
              {about}
            </p>
          )}
          <div className="mt-2 flex flex-wrap gap-1">
            {coordinator && <Badge tone="accent">Leads the team</Badge>}
            <ChangeBadges agentId={agent.id} abilities={abilities} />
            {state && (
              <Badge tone={state.tone === 'red' ? 'red' : 'slate'} title={state.text}>
                {state.title}
              </Badge>
            )}
          </div>
        </div>
        {state ? (
          <Button size="xs" variant="secondary" disabled icon={<MessageSquarePlus className="h-3.5 w-3.5" />} title={state.text}>
            Ask<span className="sr-only"> {agent.name}</span>
          </Button>
        ) : (
          <ButtonLink to={`/?agent=${encodeURIComponent(agent.id)}`} size="xs" variant="secondary" icon={<MessageSquarePlus className="h-3.5 w-3.5" />}>
            Ask<span className="sr-only"> {agent.name}</span>
          </ButtonLink>
        )}
      </article>
    </li>
  );
}
