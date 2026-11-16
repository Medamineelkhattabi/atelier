// Tools & Connections: what the team can use, grouped in plain categories, with the owner's rule
// for each action (allow / ask first / block); the connections (MCP servers) the owner adds; and,
// under "Advanced", the full technical tool table.

import { useEffect, useId, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, Bot, CircleCheck, Hand, Plug, RefreshCw, Save, Search, Wrench } from 'lucide-react';
import { getSettings, listAgents, listMcp, listTools, patchSettings, restartMcp, setToolPermission } from '../api/endpoints';
import { qk } from '../api/keys';
import type { Agent, McpServerConfig, Permission, ToolInfo, ToolListResponse } from '../api/types';
import { Page } from '../components/Page';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  Disclosure,
  EmptyState,
  ErrorState,
  Field,
  Input,
  JsonBlock,
  LoadingState,
  Mono,
  PermissionBadge,
  RiskBadge,
  Select,
  Spinner,
  TD,
  TH,
  Table,
  Textarea,
  useHelp,
} from '../components/ui';
import { CodeText, orderedEngines, runsOnText, useEngines } from '../features/team/EngineParts';
import { ABILITY_ICON } from '../features/team/TeamParts';
import {
  RULE_CHOICES,
  choiceLabel,
  claudeCodeTools,
  connectionParts,
  currentRule,
  groupRuleSummary,
  groupTools,
  ruleText,
  toolText,
  type RuleChoice,
  type ToolGroup,
} from '../features/tools/toolGroups';
import { parseJson, stringify } from '../lib/json';
import { memberName } from '../lib/plain';
import { cx } from '../lib/cx';

export function ToolsPage() {
  return (
    <Page
      title="Tools & Connections"
      description="What your team can use, and the services you connect."
      help={<p>For each action, choose the rule for the whole team. When a team member asks first, its work waits in Approvals.</p>}
    >
      <div className="space-y-8">
        <TeamAbilities />
        <Connections />
        <AiAgents />
        <section aria-labelledby="tools-advanced">
          <h2 id="tools-advanced" className="sr-only">
            Advanced
          </h2>
          <Disclosure summary="Advanced: every tool with its technical name, risk level and rules">
            <div className="space-y-4">
              <ToolRegistry />
            </div>
          </Disclosure>
        </section>
      </div>
    </Page>
  );
}

// ------------------------------------------------------------------ what your team can use

const RULE_TONE: Record<Permission, 'green' | 'amber' | 'red'> = { allow: 'green', ask: 'amber', deny: 'red' };
const RULE_ICON: Record<Permission, typeof CircleCheck> = { allow: CircleCheck, ask: Hand, deny: Ban };

function TeamAbilities() {
  const tools = useQuery({ queryKey: qk.tools, queryFn: listTools });
  const agents = useQuery({ queryKey: qk.agents, queryFn: listAgents, staleTime: 60_000 });
  const settings = useQuery({ queryKey: qk.settings, queryFn: getSettings });
  const team = useMemo(() => agents.data?.items ?? [], [agents.data]);
  const ownerRules = settings.data?.values['permissions.tools'];
  const groups = useMemo(() => {
    const builtin = (tools.data?.items ?? []).filter((t) => !t.name.startsWith('mcp__'));
    return groupTools([...builtin, ...claudeCodeTools(team, ownerRules ?? {})]);
  }, [tools.data, team, ownerRules]);
  const legend = useHelp('What the choices mean');

  return (
    <section aria-labelledby="team-abilities" className="space-y-3">
      <div className="flex items-center gap-1.5">
        <h2 id="team-abilities" className="text-base font-semibold text-zinc-900 dark:text-zinc-50">
          What your team can use
        </h2>
        {legend.button}
      </div>
      {legend.panel(<RuleLegend />)}
      {tools.isPending ? (
        <LoadingState label="Loading abilities…" />
      ) : tools.isError ? (
        <ErrorState
          error={tools.error}
          title="The abilities could not be loaded. Check that the platform is still running, then try again."
          onRetry={() => void tools.refetch()}
        />
      ) : groups.length === 0 ? (
        <EmptyState title="No ability available" description="The platform reports no tool. Restart it, then reload this page." />
      ) : (
        <ul className="grid gap-4 xl:grid-cols-2" aria-label="Ability groups">
          {groups.map((group) => (
            <AbilityGroupCard key={group.id} group={group} team={team} />
          ))}
        </ul>
      )}
    </section>
  );
}

function RuleLegend() {
  return (
    <div>
      <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
        {RULE_CHOICES.map((choice) => (
          <div key={choice.value || 'standard'}>
            <dt className="font-medium text-zinc-800 dark:text-zinc-200">{choice.value === '' ? 'Standard (recommended)' : choice.label}</dt>
            <dd className="text-zinc-600 dark:text-zinc-400">{choice.meaning}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function AbilityGroupCard({ group, team }: { group: ToolGroup; team: Agent[] }) {
  const Icon = group.id === 'other' ? Wrench : ABILITY_ICON[group.id];
  const headingId = useId();
  const users = group.usedBy.filter((id) => team.length === 0 || team.some((a) => a.id === id));
  return (
    <li className="min-w-0">
      <article aria-labelledby={headingId} className="h-full rounded-lg border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <header className="space-y-1 px-4 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <Icon className="h-4 w-4 shrink-0 text-zinc-500 dark:text-zinc-400" aria-hidden />
            <h3 id={headingId} className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
              {group.title}
            </h3>
            {group.changes ? <Badge tone="amber">Can change things</Badge> : <Badge tone="green">Only reads</Badge>}
            <span className="ml-auto text-xs text-zinc-500 dark:text-zinc-400">{groupRuleSummary(group)}</span>
          </div>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">{group.text}</p>
          <Disclosure summary={`Rules for ${group.tools.length} action${group.tools.length === 1 ? '' : 's'}`} className="pt-1">
            <p className="mb-1 text-xs text-zinc-600 dark:text-zinc-400">
              <span className="font-medium text-zinc-700 dark:text-zinc-300">Who has it: </span>
              {users.length === 0
                ? 'Nobody in the team yet.'
                : users.map((id, i) => (
                    <span key={id}>
                      {i > 0 && ', '}
                      <Link to={`/team/${encodeURIComponent(id)}`} className="text-accent-700 hover:underline dark:text-accent-300">
                        {memberName(id, team)}
                      </Link>
                    </span>
                  ))}
            </p>
            <ul className="-mx-4 divide-y divide-zinc-100 border-t border-zinc-100 dark:divide-zinc-800 dark:border-zinc-800" aria-label={`${group.title}: actions and rules`}>
              {group.tools.map((tool) => (
                <ActionRule key={tool.name} tool={tool} />
              ))}
            </ul>
          </Disclosure>
        </header>
      </article>
    </li>
  );
}

function ActionRule({ tool }: { tool: ToolInfo }) {
  const queryClient = useQueryClient();
  const selectId = useId();
  const mutation = useMutation({
    mutationFn: (permission: Permission | null) => setToolPermission(tool.name, permission),
    onSuccess: (result) => {
      queryClient.setQueryData<ToolListResponse>(qk.tools, (data) =>
        data && { items: data.items.map((t) => (t.name === tool.name ? { ...t, global_permission: result.global_permission } : t)) },
      );
      void queryClient.invalidateQueries({ queryKey: qk.tools });
      void queryClient.invalidateQueries({ queryKey: qk.agents });
      void queryClient.invalidateQueries({ queryKey: qk.settings });
    },
  });
  const { permission, yours } = currentRule(tool);
  const RuleIcon = RULE_ICON[permission];
  const value: RuleChoice = tool.global_permission ?? '';
  const meaning = RULE_CHOICES.find((c) => c.value === value)?.meaning;
  return (
    <li className="flex flex-wrap items-start gap-x-3 gap-y-2 px-4 py-2.5">
      <div className="min-w-[12rem] flex-1">
        <p className="text-sm text-zinc-900 dark:text-zinc-100">{toolText(tool)}</p>
        <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs">
          <Badge tone={RULE_TONE[permission]}>
            <RuleIcon className="h-3 w-3" aria-hidden />
            {ruleText(tool)}
          </Badge>
          <span className="text-zinc-500 dark:text-zinc-400">{yours ? 'Your rule' : 'Standard rule'}</span>
        </p>
      </div>
      <div className="w-full sm:w-56">
        <label htmlFor={selectId} className="sr-only">
          Rule for “{toolText(tool)}”
        </label>
        <div className="flex items-center gap-2">
          <Select
            id={selectId}
            value={value}
            disabled={mutation.isPending}
            aria-describedby={`${selectId}-meaning`}
            onChange={(event) => mutation.mutate((event.target.value || null) as Permission | null)}
          >
            {RULE_CHOICES.map((choice) => (
              <option key={choice.value || 'standard'} value={choice.value}>
                {choiceLabel(choice.value, tool)}
              </option>
            ))}
          </Select>
          {mutation.isPending && <Spinner label="Saving" />}
        </div>
        <p id={`${selectId}-meaning`} className="sr-only">
          {meaning}
        </p>
        {mutation.isError && (
          <p className="mt-1 text-xs text-red-600 dark:text-red-400" role="alert">
            Not saved: {(mutation.error as Error).message}. Try again.
          </p>
        )}
      </div>
    </li>
  );
}

// ------------------------------------------------------------------ connections (MCP servers)

const MCP_EXAMPLE: McpServerConfig[] = [
  // Same shape as the example in backend/pae/tools/mcp_client.py.
  { name: 'playwright', command: 'npx', args: ['@playwright/mcp@0.0.41'], env_secrets: { GITHUB_TOKEN: 'GITHUB_TOKEN' }, enabled: false, permission: 'ask' },
];

const CONNECTION_STATE: Record<string, { label: string; tone: 'green' | 'red' | 'blue' | 'slate'; hint: string }> = {
  connected: { label: 'Connected', tone: 'green', hint: 'Working: its actions can be used.' },
  starting: { label: 'Connecting', tone: 'blue', hint: 'Starting up.' },
  error: { label: 'Not working', tone: 'red', hint: 'It could not start: fix the settings, then restart.' },
  stopped: { label: 'Not running', tone: 'slate', hint: 'Use “Restart all connections” to start it.' },
  disabled: { label: 'Off', tone: 'slate', hint: 'Turned off in the settings ("enabled": false).' },
};

function connectionState(status: string) {
  return CONNECTION_STATE[status] ?? { label: status, tone: 'slate' as const, hint: '' };
}

function Connections() {
  const queryClient = useQueryClient();
  const status = useQuery({ queryKey: qk.mcp, queryFn: listMcp, refetchInterval: 15_000 });
  const settings = useQuery({ queryKey: qk.settings, queryFn: getSettings });
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const servers = settings.data?.values['mcp.servers'];
  useEffect(() => {
    if (servers !== undefined) setText(stringify(servers));
  }, [servers]);

  const save = useMutation({
    mutationFn: (value: McpServerConfig[]) => patchSettings({ 'mcp.servers': value }),
    onSuccess: (data) => {
      queryClient.setQueryData(qk.settings, data);
      void queryClient.invalidateQueries({ queryKey: qk.mcp });
      void queryClient.invalidateQueries({ queryKey: qk.tools });
    },
  });
  const about = useHelp('About connections');
  const restart = useMutation({
    mutationFn: restartMcp,
    onSuccess: (data) => {
      queryClient.setQueryData(qk.mcp, data);
      void queryClient.invalidateQueries({ queryKey: qk.tools });
    },
  });

  function submit() {
    const parsed = parseJson<unknown[]>(text, 'array', { allowEmpty: false });
    if (!parsed.ok) {
      setError(`${parsed.error} Fix the text, then save again.`);
      return;
    }
    const list = parsed.value ?? [];
    const bad = list.findIndex((s) => !s || typeof s !== 'object' || Array.isArray(s) || typeof (s as McpServerConfig).name !== 'string');
    if (bad >= 0) {
      setError(`Connection ${bad + 1} needs at least a "name" (and a "command" to start it).`);
      return;
    }
    setError(null);
    save.mutate(list as McpServerConfig[]);
  }

  return (
    <section aria-labelledby="connections" className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-1.5">
          <h2 id="connections" className="flex items-center gap-2 text-base font-semibold text-zinc-900 dark:text-zinc-50">
            <Plug className="h-4 w-4" aria-hidden />
            Connections
          </h2>
          {about.button}
        </div>
        <Button icon={<RefreshCw className="h-4 w-4" />} loading={restart.isPending} onClick={() => restart.mutate()}>
          Restart all connections
        </Button>
      </div>
      {about.panel(
        <p>
          Other tools, such as a browser or GitHub (MCP standard). Each connection&apos;s actions ask you first by default, and a team member uses
          them once its advanced settings include them.
        </p>,
      )}
      {restart.isError && <ErrorState compact error={restart.error} title="The connections could not be restarted." />}
      <Card>
        {status.isPending ? (
          <LoadingState />
        ) : status.isError ? (
          <div className="p-4">
            <ErrorState compact error={status.error} title="The connections could not be listed." onRetry={() => void status.refetch()} />
          </div>
        ) : status.data.items.length === 0 ? (
          <EmptyState
            icon={<Plug className="h-5 w-5" />}
            title="No connection yet"
            description="Optional: your team works without them."
          />
        ) : (
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-800" aria-label="Connections">
            {status.data.items.map((server) => {
              const state = connectionState(server.status);
              return (
                <li key={server.name} className="space-y-1.5 px-4 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-zinc-900 dark:text-zinc-100">{server.name}</span>
                    <Badge tone={state.tone} dot title={state.hint}>
                      {state.label}
                    </Badge>
                    <span className="text-xs text-zinc-500 dark:text-zinc-400">
                      {server.tools.length} action{server.tools.length === 1 ? '' : 's'} ·{' '}
                      {(server.config.permission ?? 'ask') === 'ask'
                        ? 'asks you first'
                        : server.config.permission === 'allow'
                          ? 'allowed without asking'
                          : 'blocked'}
                    </span>
                  </div>
                  {server.error && <p className="break-words text-xs text-red-600 dark:text-red-400">Reason: {server.error}</p>}
                  {server.tools.length > 0 && (
                    <Disclosure summary={`See its ${server.tools.length} action${server.tools.length === 1 ? '' : 's'}`}>
                      <ul className="flex flex-wrap gap-1">
                        {server.tools.map((t) => (
                          <li key={t}>
                            <Badge>{connectionParts(t).action || t}</Badge>
                          </li>
                        ))}
                      </ul>
                    </Disclosure>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <Disclosure summary="Set up connections (technical)">
      <Card>
        <CardBody className="space-y-4">
          <Field
            label="Connection settings (JSON)"
            htmlFor="mcp-config"
            error={error ?? undefined}
            hint='A list of {name, command, args, env_secrets, enabled, permission, timeout_s}. Saving restarts them.'
          >
            {settings.isPending ? (
              <Spinner />
            ) : settings.isError ? (
              <ErrorState compact error={settings.error} title="The current settings could not be loaded." />
            ) : (
              <Textarea id="mcp-config" mono rows={10} value={text} aria-invalid={!!error} onChange={(e) => setText(e.target.value)} />
            )}
          </Field>
          <Disclosure summary="Example">
            <JsonBlock value={MCP_EXAMPLE} />
          </Disclosure>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            Pin package versions in <Mono>args</Mono>. Refer to passwords by name (saved in{' '}
            <Link to="/settings?section=keys" className="font-medium underline">
              Settings
            </Link>
            ), never here.
          </p>
          {save.isError && <ErrorState compact error={save.error} title="Not saved. Check the settings, then try again." />}
          {save.isSuccess && <Alert tone="green">Saved; the connections restarted.</Alert>}
          <div className="flex justify-end">
            <Button variant="primary" icon={<Save className="h-4 w-4" />} loading={save.isPending} onClick={submit} disabled={!settings.data}>
              Save connections
            </Button>
          </div>
        </CardBody>
      </Card>
      </Disclosure>
    </section>
  );
}

// ------------------------------------------------------------------ AI agents the team can run on

function AiAgents() {
  const engines = useEngines();
  const list = orderedEngines(engines.data?.items);
  return (
    <section aria-labelledby="ai-agents" className="space-y-3">
      <div className="space-y-1">
        <h2 id="ai-agents" className="flex items-center gap-2 text-base font-semibold text-zinc-900 dark:text-zinc-50">
          <Bot className="h-4 w-4" aria-hidden />
          AI agents
        </h2>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          Your team can run on Claude Code or on any of these agents. Each one uses its own sign-in; the platform never asks for an API key.
        </p>
      </div>
      <Card>
        {engines.isPending ? (
          <LoadingState />
        ) : engines.isError ? (
          <div className="p-4">
            <ErrorState compact error={engines.error} title="The AI agents could not be listed." onRetry={() => void engines.refetch()} />
          </div>
        ) : (
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-800" aria-label="AI agents">
            {list.map((engine) => (
              <li key={engine.id} className="space-y-1 px-4 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-zinc-900 dark:text-zinc-100">{engine.name}</span>
                  {engine.installed ? (
                    <Badge tone="green" dot>
                      Installed
                    </Badge>
                  ) : (
                    <Badge tone="slate" dot>
                      Not installed
                    </Badge>
                  )}
                  {engine.plan && <span className="text-xs text-zinc-500 dark:text-zinc-400">{runsOnText(engine.plan)}</span>}
                </div>
                {!engine.installed && engine.install && (
                  <p className="text-xs text-zinc-600 dark:text-zinc-400">
                    Install: <code className="rounded bg-zinc-100 px-1 py-0.5 font-mono text-[0.75rem] text-zinc-800 dark:bg-zinc-800 dark:text-zinc-200">{engine.install}</code>
                  </p>
                )}
                {engine.installed && !engine.builtin && engine.sign_in && (
                  <p className="text-xs text-zinc-600 dark:text-zinc-400">
                    Sign in once: <CodeText text={engine.sign_in} />
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </section>
  );
}

// ------------------------------------------------------------------ advanced: technical table

function ToolRegistry() {
  const tools = useQuery({ queryKey: qk.tools, queryFn: listTools });
  const agents = useQuery({ queryKey: qk.agents, queryFn: listAgents, staleTime: 60_000 });
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const items = useMemo(() => tools.data?.items ?? [], [tools.data]);
  const categories = useMemo(() => [...new Set(items.map((t) => t.category))].sort(), [items]);
  const filtered = items.filter(
    (t) =>
      (!category || t.category === category) &&
      (!search.trim() || `${t.name} ${t.description}`.toLowerCase().includes(search.trim().toLowerCase())),
  );

  return (
    <Card>
      <CardHeader
        title="Tool registry"
        description="Permission layers, strongest first: global (yours) > team member > argument rules > tool default. A deny at any layer wins."
      />
      <div className="flex flex-wrap gap-3 border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
        <div className="relative min-w-[12rem] flex-1">
          <label htmlFor="tool-search" className="sr-only">
            Search tools
          </label>
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-zinc-400" aria-hidden />
          <Input id="tool-search" className="pl-8" placeholder="Search tools" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <div>
          <label htmlFor="tool-category" className="sr-only">
            Category
          </label>
          <Select id="tool-category" value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">All categories</option>
            {categories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </Select>
        </div>
      </div>
      {tools.isPending ? (
        <LoadingState />
      ) : tools.isError ? (
        <div className="p-4">
          <ErrorState error={tools.error} onRetry={() => void tools.refetch()} />
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState title="No tool matches" />
      ) : (
        <Table>
          <thead>
            <tr>
              <th className={TH}>Tool</th>
              <th className={TH}>Category</th>
              <th className={TH}>Risk</th>
              <th className={TH}>Default</th>
              <th className={TH}>Global override</th>
              <th className={TH}>Used by</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {filtered.map((tool) => (
              <ToolRow key={tool.name} tool={tool} team={agents.data?.items ?? []} />
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}

function ToolRow({ tool, team }: { tool: ToolInfo; team: Agent[] }) {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: (permission: Permission | null) => setToolPermission(tool.name, permission),
    onSuccess: (result) => {
      queryClient.setQueryData<ToolListResponse>(qk.tools, (data) =>
        data && { items: data.items.map((t) => (t.name === tool.name ? { ...t, global_permission: result.global_permission } : t)) },
      );
      void queryClient.invalidateQueries({ queryKey: qk.agents });
      void queryClient.invalidateQueries({ queryKey: qk.settings });
    },
  });
  const selectId = `perm-${tool.name}`;
  return (
    <tr className="align-top">
      <td className={TD}>
        <Mono className="font-semibold">{tool.name}</Mono>
        {tool.source !== 'builtin' && <Badge className="ml-2">{tool.source}</Badge>}
        {tool.untrusted_output && (
          <Badge tone="amber" className="ml-2" title="Output is wrapped as untrusted data for the model">
            untrusted output
          </Badge>
        )}
        <p className="mt-0.5 max-w-xl text-xs text-zinc-500 dark:text-zinc-400">{tool.description}</p>
        <Disclosure summary="Input schema" className="mt-1">
          <JsonBlock value={tool.input_schema} maxHeight="max-h-60" />
        </Disclosure>
      </td>
      <td className={`${TD} text-xs`}>{tool.category}</td>
      <td className={TD}>
        <RiskBadge risk={tool.risk} />
      </td>
      <td className={TD}>
        <PermissionBadge permission={tool.default_permission} />
        <div className="mt-1 text-[0.7rem] text-zinc-400">timeout {tool.timeout_s}s</div>
      </td>
      <td className={TD}>
        <label htmlFor={selectId} className="sr-only">
          Global permission for {tool.name}
        </label>
        <div className="flex items-center gap-2">
          <Select
            id={selectId}
            className="w-36"
            value={tool.global_permission ?? ''}
            disabled={mutation.isPending}
            onChange={(e) => mutation.mutate((e.target.value || null) as Permission | null)}
          >
            <option value="">No override</option>
            <option value="allow">allow</option>
            <option value="ask">ask</option>
            <option value="deny">deny</option>
          </Select>
          {mutation.isPending && <Spinner label="Saving" />}
        </div>
        {mutation.isError && <p className="mt-1 text-xs text-red-600">{(mutation.error as Error).message}</p>}
      </td>
      <td className={TD}>
        <div className="flex max-w-xs flex-wrap gap-1">
          {tool.used_by.length === 0 ? (
            <span className="text-xs text-zinc-400">—</span>
          ) : (
            tool.used_by.map((agentId) => (
              <Link
                key={agentId}
                to={`/team/${encodeURIComponent(agentId)}`}
                className={cx('rounded bg-zinc-100 px-1.5 py-0.5 text-[0.7rem] text-zinc-700 hover:underline dark:bg-zinc-800 dark:text-zinc-300')}
                title={agentId}
              >
                {memberName(agentId, team)}
              </Link>
            ))
          )}
        </div>
      </td>
    </tr>
  );
}
