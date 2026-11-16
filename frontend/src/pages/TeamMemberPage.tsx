// A team member's profile, in short sections: when it helps, what it can do (and whether it asks
// first), what it will not do, what it hands back, who it works with, its recent work, on/off.
// Configuration lives on the secondary "Advanced settings" screen.

import { useId } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Ban, Hand, MessageSquarePlus, Power, PowerOff, Settings2, ShieldCheck } from 'lucide-react';
import { getAgent, listRuns, patchAgent } from '../api/endpoints';
import { ApiError } from '../api/client';
import { qk } from '../api/keys';
import type { Agent, AgentDetailResponse, Engine, ProviderName, RunListParams } from '../api/types';
import { Page } from '../components/Page';
import {
  Alert,
  Badge,
  Button,
  ButtonLink,
  Card,
  CardBody,
  CardHeader,
  Disclosure,
  EmptyState,
  ErrorState,
  KeyValue,
  LoadingState,
  Mono,
  Select,
  Spinner,
} from '../components/ui';
import { useToast } from '../components/toast';
import { AgentAvatar } from '../features/workspace/agentAvatar';
import { CLAUDE_CODE_CHOICE, CodeText, orderedEngines, runsOnText, useEngines } from '../features/team/EngineParts';
import { AbilityList, ChangeBadges, MemberStateNote, WorksWithLinks, useTeamData } from '../features/team/TeamParts';
import { canChange, deliverables, memberAbilities, memberChangeSummary, memberState, reportsOutcome } from '../features/team/teamText';
import { COORDINATOR_ID, INTERNAL_AGENTS, plainTaskText, workStatus } from '../lib/plain';
import { formatDateTime, formatRelative, truncate } from '../lib/format';
import { SCRIPTED_LABEL, providerLabel } from '../lib/status';

const BACK = { to: '/team', label: 'My AI Team' };

export function TeamMemberPage() {
  const { agentId = '' } = useParams();
  const query = useQuery({ queryKey: qk.agent(agentId), queryFn: () => getAgent(agentId), enabled: !!agentId });
  const { agents, tools } = useTeamData();

  if (query.isPending) {
    return (
      <Page title="Team member" back={BACK}>
        <LoadingState />
      </Page>
    );
  }
  if (query.isError) {
    const missing = query.error instanceof ApiError && query.error.status === 404;
    return (
      <Page title="Team member" back={BACK}>
        {missing ? (
          <EmptyState
            title="This team member does not exist"
            action={<ButtonLink to="/team">See my AI team</ButtonLink>}
          />
        ) : (
          <ErrorState
            error={query.error}
            title="This profile could not be loaded. Check that the platform is still running, then try again."
            onRetry={() => void query.refetch()}
          />
        )}
      </Page>
    );
  }

  const { agent } = query.data;
  const team = agents.data?.items ?? [agent];
  const abilities = memberAbilities(agent, tools.data?.items);
  const internal = INTERNAL_AGENTS.has(agent.id);
  const coordinator = agent.id === COORDINATOR_ID;
  const ready = !memberState(agent);
  const ask = `/?agent=${encodeURIComponent(agent.id)}`;

  return (
    <Page
      title={agent.name}
      documentTitle={agent.name}
      back={BACK}
      description={agent.responsibility || agent.description}
      help={agent.responsibility && agent.description && agent.description !== agent.responsibility ? <p>{agent.description}</p> : undefined}
      actions={
        <>
          {!internal &&
            (ready ? (
              <ButtonLink to={ask} variant="primary" icon={<MessageSquarePlus className="h-4 w-4" />}>
                Ask {agent.name}
              </ButtonLink>
            ) : (
              <Button variant="primary" disabled icon={<MessageSquarePlus className="h-4 w-4" />}>
                Ask {agent.name}
              </Button>
            ))}
          <ButtonLink to={`/team/${encodeURIComponent(agent.id)}/settings`} variant="ghost" icon={<Settings2 className="h-4 w-4" />}>
            Advanced settings
          </ButtonLink>
        </>
      }
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <AgentAvatar agentId={agent.id} name={agent.name} />
          {coordinator && <Badge tone="accent">Leads the team</Badge>}
          <ChangeBadges agentId={agent.id} abilities={abilities} />
          {internal && <Badge tone="slate">Behind the scenes</Badge>}
        </div>
        <MemberStateNote agent={agent} showProblems />
        {internal && (
          <Alert tone="gray">Works for the platform itself: you never need to ask it for work.</Alert>
        )}

        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <div className="min-w-0 space-y-4">
            {((agent.when_to_use ?? []).length > 0 || agent.input_hint) && (
              <Card>
                <CardBody className="space-y-3 text-sm text-zinc-800 dark:text-zinc-200">
                  {(agent.when_to_use ?? []).length > 0 && (
                    <div>
                      <SectionTitle>Useful when</SectionTitle>
                      <ul className="mt-1 list-disc space-y-0.5 pl-5 text-zinc-700 dark:text-zinc-300">
                        {(agent.when_to_use ?? []).map((item) => (
                          <li key={item}>{item}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {agent.input_hint && (
                    <div>
                      <SectionTitle>What to give it</SectionTitle>
                      <p className="mt-0.5 text-zinc-700 dark:text-zinc-300">{agent.input_hint}</p>
                    </div>
                  )}
                </CardBody>
              </Card>
            )}

            <Card>
              <CardBody className="space-y-2 text-sm">
                <SectionTitle>What it can do</SectionTitle>
                <AbilityList abilities={abilities} label={`What ${agent.name} can do`} />
                <p className="flex items-start gap-1.5 text-xs text-zinc-600 dark:text-zinc-400">
                  {canChange(abilities) ? (
                    <Hand className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" aria-hidden />
                  ) : (
                    <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" aria-hidden />
                  )}
                  <span>
                    {memberChangeSummary(agent.id, abilities)}{' '}
                    {abilities.some((a) => a.asksFirst && !a.blocked) && (
                      <>
                        Requests wait in{' '}
                        <Link to="/approvals" className="font-medium text-accent-700 hover:underline dark:text-accent-300">
                          Approvals
                        </Link>
                        .{' '}
                      </>
                    )}
                    <Link to="/tools" className="font-medium text-accent-700 hover:underline dark:text-accent-300">
                      Change the rules
                    </Link>
                  </span>
                </p>
              </CardBody>
            </Card>

            {(agent.boundaries ?? []).length > 0 && (
              <Card>
                <CardBody className="space-y-2">
                  <SectionTitle>What it will not do</SectionTitle>
                  <ul className="space-y-1 text-sm text-zinc-800 dark:text-zinc-200" aria-label="What it will not do">
                    {(agent.boundaries ?? []).map((item) => (
                      <li key={item} className="flex items-start gap-2">
                        <Ban className="mt-0.5 h-4 w-4 shrink-0 text-zinc-400" aria-hidden />
                        <span>{item}</span>
                      </li>
                    ))}
                  </ul>
                </CardBody>
              </Card>
            )}

            <WhatYouGetBack agent={agent} />
          </div>

          <aside className="min-w-0 space-y-4">
            <Card>
              <CardBody className="space-y-2 text-sm text-zinc-700 dark:text-zinc-300">
                <SectionTitle>Works with</SectionTitle>
                {coordinator ? (
                  <p>Anyone in the team: it hands out the steps and combines the results.</p>
                ) : (agent.works_with ?? []).length > 0 ? (
                  <WorksWithLinks ids={(agent.works_with ?? []).filter((id) => id !== agent.id)} agents={team} />
                ) : (
                  <p>It works on its own.</p>
                )}
              </CardBody>
            </Card>
            <RecentWork agent={agent} />
            {!internal && <RunsOn agent={agent} />}
            {!internal && <TurnOnOff agent={agent} />}
            <Card>
              <CardBody>
                <Disclosure summary="Technical details">
                  <KeyValue
                    items={[
                      { label: 'Identifier', value: <Mono>{agent.id}</Mono> },
                      { label: 'Version', value: agent.version },
                      { label: 'AI model', value: <Mono>{agent.effective_model ?? 'Claude Code default'}</Mono> },
                      { label: 'Runs on', value: providerLabel(agent.effective_provider) },
                      { label: 'Defined in', value: agent.source === 'custom' ? 'Created in this platform' : 'A file of the platform' },
                      { label: 'Revision', value: <Mono>{agent.revision}</Mono> },
                      { label: 'Last changed', value: formatDateTime(agent.updated_at) },
                    ]}
                  />
                </Disclosure>
              </CardBody>
            </Card>
          </aside>
        </div>
      </div>
    </Page>
  );
}

/** A short section heading inside a profile card. */
function SectionTitle({ children, id }: { children: string; id?: string }) {
  return (
    <h2 id={id} className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
      {children}
    </h2>
  );
}

interface EngineChoice {
  value: string;
  name: string;
  engine?: Engine;
  disabled: boolean;
}

/** Which agent the team member runs on: Claude Code (the platform default) or an installed ACP agent. */
function RunsOn({ agent }: { agent: Agent }) {
  const headingId = useId();
  if (agent.id === COORDINATOR_ID) {
    return (
      <Card>
        <CardBody className="space-y-1 text-sm text-zinc-700 dark:text-zinc-300">
          <SectionTitle id={headingId}>Runs on</SectionTitle>
          <p className="font-medium text-zinc-900 dark:text-zinc-100">Claude Code</p>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">The Coordinator plans with tools only Claude Code can use today.</p>
        </CardBody>
      </Card>
    );
  }
  return <EnginePicker agent={agent} headingId={headingId} />;
}

function EnginePicker({ agent, headingId }: { agent: Agent; headingId: string }) {
  const queryClient = useQueryClient();
  const { notify } = useToast();
  const engines = useEngines();
  const list = orderedEngines(engines.data?.items);
  const claude = list.find((e) => e.builtin);
  const choices: EngineChoice[] = [
    { value: CLAUDE_CODE_CHOICE, name: claude?.name ?? 'Claude Code', engine: claude, disabled: false },
    ...list.filter((e) => !e.builtin).map((e) => ({ value: e.provider, name: e.name, engine: e, disabled: !e.installed })),
  ];
  const current = agent.provider.startsWith('acp:') || agent.provider === 'scripted' ? agent.provider : CLAUDE_CODE_CHOICE;
  if (!choices.some((c) => c.value === current)) {
    choices.push({ value: current, name: current === 'scripted' ? SCRIPTED_LABEL : providerLabel(current), disabled: false });
  }
  const nameOf = (value: string) => choices.find((c) => c.value === value)?.name ?? providerLabel(value);

  const save = useMutation({
    mutationFn: (provider: ProviderName) => patchAgent(agent.id, { overrides: { provider } }),
    onSuccess: (data: AgentDetailResponse, provider) => {
      queryClient.setQueryData(qk.agent(agent.id), data);
      void queryClient.invalidateQueries({ queryKey: qk.agents, exact: true });
      notify(`${nameOf(provider)} now runs ${data.agent.name}`);
    },
  });
  const value: string = save.isPending && save.variables ? save.variables : current;
  const engine = choices.find((c) => c.value === value)?.engine;
  const note =
    value === CLAUDE_CODE_CHOICE ? (
      'Runs on your Claude plan.'
    ) : engine && !engine.installed ? (
      <>
        Not installed on this computer.{' '}
        <Link to="/tools" className="font-medium text-accent-700 hover:underline dark:text-accent-300">
          How to install it
        </Link>
      </>
    ) : engine ? (
      <>
        {runsOnText(engine.plan)}
        {engine.sign_in && (
          <>
            {' '}
            Sign in once: <CodeText text={engine.sign_in} />
          </>
        )}
      </>
    ) : null;

  return (
    <Card>
      <CardBody className="space-y-2 text-sm text-zinc-700 dark:text-zinc-300">
        <SectionTitle id={headingId}>Runs on</SectionTitle>
        {engines.isPending ? (
          <Spinner label="Loading the agents" />
        ) : engines.isError ? (
          <ErrorState compact error={engines.error} title="The agents could not be listed." onRetry={() => void engines.refetch()} />
        ) : (
          <>
            <div className="flex items-center gap-2">
              <Select
                aria-labelledby={headingId}
                value={value}
                disabled={save.isPending}
                onChange={(event) => save.mutate(event.target.value as ProviderName)}
              >
                {choices.map((choice) => (
                  <option key={choice.value} value={choice.value} disabled={choice.disabled}>
                    {choice.disabled ? `${choice.name} (not installed)` : choice.name}
                  </option>
                ))}
              </Select>
              {save.isPending && <Spinner label="Saving" />}
            </div>
            {note && <p className="text-xs text-zinc-500 dark:text-zinc-400">{note}</p>}
          </>
        )}
        {save.isError && <ErrorState compact error={save.error} title="Not changed. Try again." />}
      </CardBody>
    </Card>
  );
}

function WhatYouGetBack({ agent }: { agent: Agent }) {
  const items = deliverables(agent.output_schema);
  return (
    <Card>
      <CardBody className="space-y-2 text-sm text-zinc-800 dark:text-zinc-200">
        <SectionTitle>What you get back</SectionTitle>
        {items.length === 0 ? (
          <p>A written answer.</p>
        ) : (
          <ul className="list-disc space-y-0.5 pl-5" aria-label="What you get back">
            {items.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        )}
        {reportsOutcome(agent.output_schema) && (
          <p className="text-xs text-zinc-500 dark:text-zinc-400">Each answer also says if it was fully done, partly done or could not be done.</p>
        )}
      </CardBody>
    </Card>
  );
}

function RecentWork({ agent }: { agent: Agent }) {
  const params: RunListParams = { agent_id: agent.id, limit: 8 };
  const runs = useQuery({ queryKey: qk.runList(params), queryFn: () => listRuns(params) });
  return (
    <Card>
      <CardHeader title="Recent work" />
      {runs.isPending ? (
        <CardBody>
          <Spinner label="Loading recent work" />
        </CardBody>
      ) : runs.isError ? (
        <CardBody>
          <ErrorState compact error={runs.error} title="Recent work could not be loaded." onRetry={() => void runs.refetch()} />
        </CardBody>
      ) : runs.data.items.length === 0 ? (
        <CardBody>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">It has not worked on anything yet.</p>
        </CardBody>
      ) : (
        <ul className="divide-y divide-zinc-100 dark:divide-zinc-800" aria-label={`Recent work of ${agent.name}`}>
          {runs.data.items.map((run) => {
            const status = workStatus(run.status);
            return (
              <li key={run.id}>
                <Link
                  to={`/workspace/${encodeURIComponent(run.root_run_id || run.id)}`}
                  className="block px-4 py-2 hover:bg-zinc-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-500 dark:hover:bg-zinc-800/50"
                >
                  <span className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-sm text-zinc-900 dark:text-zinc-100">{truncate(plainTaskText(run.task) || 'Untitled task', 110)}</span>
                    <Badge tone={status.tone} dot>
                      {status.label}
                    </Badge>
                  </span>
                  <span className="mt-0.5 block text-xs text-zinc-500 dark:text-zinc-400">
                    {run.parent_run_id && <>Part of a bigger task · </>}
                    {formatRelative(run.created_at)}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      <div className="border-t border-zinc-100 px-4 py-2.5 dark:border-zinc-800">
        <Link to="/work" className="inline-flex items-center gap-1 text-xs font-medium text-accent-700 hover:underline dark:text-accent-300">
          All your work <ArrowRight className="h-3.5 w-3.5" aria-hidden />
        </Link>
      </div>
    </Card>
  );
}

function TurnOnOff({ agent }: { agent: Agent }) {
  const queryClient = useQueryClient();
  const { notify } = useToast();
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => patchAgent(agent.id, { enabled }),
    onSuccess: (data: AgentDetailResponse) => {
      queryClient.setQueryData(qk.agent(agent.id), data);
      void queryClient.invalidateQueries({ queryKey: qk.agents, exact: true });
      notify(data.agent.enabled ? `${data.agent.name} is on` : `${data.agent.name} is off`);
    },
  });
  const coordinator = agent.id === COORDINATOR_ID;
  return (
    <Card>
      <CardHeader title={agent.enabled ? 'On: it can be given work' : 'Off: it cannot be given work'} />
      <CardBody className="space-y-3 text-sm text-zinc-700 dark:text-zinc-300">
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          {agent.enabled
            ? `When off, nobody can give it work${coordinator ? ' and requests that need it cannot start' : ''}. Past work stays.`
            : 'Turn it on to give it work again.'}
        </p>
        {toggle.isError && <ErrorState compact error={toggle.error} title="Not changed. Try again." />}
        <Button
          variant={agent.enabled ? 'secondary' : 'primary'}
          icon={agent.enabled ? <PowerOff className="h-4 w-4" /> : <Power className="h-4 w-4" />}
          loading={toggle.isPending}
          onClick={() => toggle.mutate(!agent.enabled)}
        >
          {agent.enabled ? `Turn off ${agent.name}` : `Turn on ${agent.name}`}
        </Button>
      </CardBody>
    </Card>
  );
}
