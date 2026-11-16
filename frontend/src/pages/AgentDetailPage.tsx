import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, RotateCcw, Save, Trash2, TriangleAlert } from 'lucide-react';
import { deleteAgent, getAgent, listAgents, listTools, patchAgent, replaceAgent, resetAgent } from '../api/endpoints';
import { qk } from '../api/keys';
import type { Agent, AgentDetailResponse, AgentOverrides, Effort, Permission, ProviderName } from '../api/types';
import { Page } from '../components/Page';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  CodeBlock,
  ConfirmDialog,
  CopyButton,
  EmptyState,
  ErrorState,
  Field,
  Input,
  JsonBlock,
  KeyValue,
  LoadingState,
  Mono,
  PermissionBadge,
  RiskBadge,
  Select,
  StatusBadge,
  TD,
  TH,
  Table,
  Tabs,
  Textarea,
  Toggle,
} from '../components/ui';
import { AGENT_LIMIT_KEYS, definitionOf, outputContract } from '../lib/agents';
import { orderedEngines, useEngines } from '../features/team/EngineParts';
import { WorksWithLinks } from '../features/team/TeamParts';
import { formatCost, formatDateTime, formatDuration, formatPercent, formatTokens, truncate } from '../lib/format';
import { parseJson, stringify } from '../lib/json';
import { SCRIPTED_LABEL, providerLabel, riskDescription } from '../lib/status';

type Tab = 'overview' | 'tools' | 'instructions' | 'configuration' | 'history' | 'export' | 'definition';

export function AgentDetailPage() {
  const { agentId = '' } = useParams();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const query = useQuery({ queryKey: qk.agent(agentId), queryFn: () => getAgent(agentId), enabled: !!agentId });
  const [tab, setTab] = useState<Tab>('overview');
  const [confirmDelete, setConfirmDelete] = useState(false);

  const update = (data: AgentDetailResponse) => {
    queryClient.setQueryData(qk.agent(agentId), data);
    void queryClient.invalidateQueries({ queryKey: qk.agents, exact: true });
  };
  const toggle = useMutation({ mutationFn: (enabled: boolean) => patchAgent(agentId, { enabled }), onSuccess: update });
  const remove = useMutation({
    mutationFn: () => deleteAgent(agentId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.agents });
      navigate('/team');
    },
  });

  if (query.isPending) {
    return (
      <Page title="Advanced settings" back={{ to: `/team/${encodeURIComponent(agentId)}`, label: 'Profile' }}>
        <LoadingState />
      </Page>
    );
  }
  if (query.isError) {
    return (
      <Page title="Advanced settings" back={{ to: '/team', label: 'My AI Team' }}>
        <ErrorState
          error={query.error}
          title="These settings could not be loaded. Check that the platform is still running, then try again."
          onRetry={() => void query.refetch()}
        />
      </Page>
    );
  }
  const { agent, recent_runs: runs, toml } = query.data;
  const tabs: { id: Tab; label: string; count?: number }[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'tools', label: 'Tools', count: agent.tools_detail.length },
    { id: 'instructions', label: 'Instructions & schema' },
    { id: 'configuration', label: 'Configuration' },
    { id: 'history', label: 'History', count: runs.length },
    { id: 'export', label: 'TOML export' },
    ...(agent.source === 'custom' ? [{ id: 'definition' as const, label: 'Edit definition' }] : []),
  ];

  return (
    <Page
      title={`Advanced settings — ${agent.name}`}
      back={{ to: `/team/${encodeURIComponent(agent.id)}`, label: `${agent.name}'s profile` }}
      description={
        <span className="flex flex-wrap items-center gap-2">
          <Mono>{agent.id}</Mono>
          <span>v{agent.version}</span>
          <span title="Revision: hash of the effective definition">
            rev <Mono>{agent.revision}</Mono>
          </span>
          <Badge tone={agent.source === 'custom' ? 'accent' : 'gray'}>{agent.source === 'custom' ? 'custom' : 'file'}</Badge>
          <StatusBadge status={agent.status} />
        </span>
      }
      actions={
        <>
          <span className="flex items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300">
            <Toggle
              label={agent.enabled ? 'Enabled' : 'Disabled'}
              showLabel
              checked={agent.enabled}
              disabled={toggle.isPending}
              onChange={(value) => toggle.mutate(value)}
            />
          </span>
          {agent.source === 'custom' && (
            <Button variant="ghost" icon={<Trash2 className="h-4 w-4" />} onClick={() => setConfirmDelete(true)}>
              Delete
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-4">
        <Alert tone="amber" icon={<TriangleAlert className="h-4 w-4" />}>
          For fine-tuning only. In plain words:{' '}
          <Link to={`/team/${encodeURIComponent(agent.id)}`} className="font-medium underline">
            {agent.name}’s profile
          </Link>
          .
        </Alert>
        {toggle.isError && <ErrorState compact error={toggle.error} title="Not saved" />}
        {agent.problems.length > 0 && (
          <Alert tone="red" title="This agent is misconfigured">
            {agent.problems.join('; ')}
          </Alert>
        )}
        <Tabs<Tab> label="Advanced settings sections" tabs={tabs} value={tab} onChange={setTab} />
        {tab === 'overview' && <Overview agent={agent} />}
        {tab === 'tools' && <ToolsTab agent={agent} />}
        {tab === 'instructions' && <InstructionsTab agent={agent} />}
        {tab === 'configuration' && <OverridesEditor agent={agent} onSaved={update} />}
        {tab === 'history' && <HistoryTab runs={runs} />}
        {tab === 'export' && <ExportTab agent={agent} toml={toml} />}
        {tab === 'definition' && <DefinitionEditor agent={agent} onSaved={update} />}
      </div>
      <ConfirmDialog
        open={confirmDelete}
        title={`Delete ${agent.name}?`}
        confirmLabel="Delete agent"
        danger
        loading={remove.isPending}
        onConfirm={() => remove.mutate()}
        onCancel={() => setConfirmDelete(false)}
      >
        The custom definition is removed. Past runs stay in the history. Export the TOML first if you want to keep it.
        {remove.isError && <p className="mt-2 text-red-600">{String((remove.error as Error).message)}</p>}
      </ConfirmDialog>
    </Page>
  );
}

function Overview({ agent }: { agent: Agent }) {
  const agents = useQuery({ queryKey: qk.agents, queryFn: listAgents, staleTime: 60_000 });
  const team = agents.data?.items ?? [];
  const s = agent.stats;
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card className="lg:col-span-2">
        <CardHeader title="Responsibility" />
        <CardBody className="space-y-4 text-sm">
          <p className="text-base font-medium text-zinc-900 dark:text-zinc-100">{agent.responsibility || agent.description}</p>
          {agent.responsibility && agent.description && agent.description !== agent.responsibility && (
            <p className="text-zinc-700 dark:text-zinc-300">{agent.description}</p>
          )}
          {agent.purpose && <p className="text-zinc-600 dark:text-zinc-400">{agent.purpose}</p>}
          {(agent.boundaries ?? []).length > 0 && (
            <div>
              <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-zinc-500">Does not do (hands off instead)</h3>
              <ul className="list-inside list-disc space-y-0.5 text-zinc-700 dark:text-zinc-300">
                {(agent.boundaries ?? []).map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
            </div>
          )}
          {(agent.works_with ?? []).length > 0 && (
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Works with</h3>
              <WorksWithLinks ids={agent.works_with ?? []} agents={team} className="mt-1" />
            </div>
          )}
          <OutputContract agent={agent} />
          {agent.tools_detail.length > 0 && (
            <div>
              <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-zinc-500">Tools, and what they can do</h3>
              <ul className="space-y-1">
                {agent.tools_detail.map((tool) => (
                  <li key={tool.name} className="flex flex-wrap items-center gap-2">
                    <Mono className="font-semibold text-zinc-900 dark:text-zinc-100">{tool.name}</Mono>
                    <span title={riskDescription(tool.risk)}>
                      <RiskBadge risk={tool.risk} />
                    </span>
                    {tool.permission === 'ask' && <Badge tone="amber">asks you first</Badge>}
                    {tool.permission === 'deny' && <Badge tone="red">blocked</Badge>}
                    {!tool.available && <Badge tone="red">unavailable</Badge>}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {agent.capabilities.length > 0 && (
            <div>
              <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-zinc-500">Capabilities</h3>
              <ul className="list-inside list-disc space-y-0.5 text-zinc-700 dark:text-zinc-300">
                {agent.capabilities.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            </div>
          )}
          {agent.input_hint && (
            <div>
              <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-zinc-500">Expected input</h3>
              <p className="text-zinc-700 dark:text-zinc-300">{agent.input_hint}</p>
            </div>
          )}
          {agent.tags.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {agent.tags.map((t) => (
                <Badge key={t}>{t}</Badge>
              ))}
            </div>
          )}
        </CardBody>
      </Card>
      <div className="space-y-4">
        <Card>
          <CardHeader title="Execution" />
          <CardBody>
            <KeyValue
              items={[
                { label: 'Provider', value: `${providerLabel(agent.effective_provider)}${agent.provider === 'default' ? ' (platform default)' : ''}` },
                { label: 'Model', value: <Mono>{agent.effective_model ?? 'provider default'}</Mono> },
                { label: 'Effort', value: agent.effort ?? '—' },
                { label: 'Delegates', value: agent.delegates.length ? agent.delegates.join(', ') : '—' },
                { label: 'Claude Code tools', value: agent.claude_code_tools.length ? agent.claude_code_tools.join(', ') : '—' },
                { label: 'Updated', value: formatDateTime(agent.updated_at) },
              ]}
            />
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Statistics" />
          <CardBody>
            <KeyValue
              items={[
                { label: 'Runs', value: s.runs ?? 0 },
                { label: 'Completed / failed', value: `${s.completed ?? 0} / ${s.failed ?? 0}` },
                { label: 'Active', value: s.active ?? 0 },
                { label: 'Success rate', value: formatPercent(s.success_rate) },
                { label: 'Last run', value: formatDateTime(s.last_run_at) },
                { label: 'Cost', value: `${formatCost(s.cost_usd ?? 0)} estimated` },
              ]}
            />
          </CardBody>
        </Card>
      </div>
    </div>
  );
}

function ToolsTab({ agent }: { agent: Agent }) {
  if (agent.tools_detail.length === 0 && agent.claude_code_tools.length === 0) {
    return <EmptyState title="This agent has no tools" description="It can only answer from the task text." />;
  }
  return (
    <Card>
      <CardHeader
        title="Tools"
        description="Agent setting or tool default. A deny at any layer wins."
      />
      <Table>
        <thead>
          <tr>
            <th className={TH}>Tool</th>
            <th className={TH}>Risk</th>
            <th className={TH}>Permission</th>
            <th className={TH}>Description</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {agent.tools_detail.map((tool) => (
            <tr key={tool.name}>
              <td className={TD}>
                <Mono>{tool.name}</Mono>
                {!tool.available && (
                  <Badge tone="red" className="ml-2">
                    unavailable
                  </Badge>
                )}
              </td>
              <td className={TD}>
                <RiskBadge risk={tool.risk} />
                <div className="mt-1 max-w-[14rem] text-xs text-zinc-500 dark:text-zinc-400">{riskDescription(tool.risk)}</div>
              </td>
              <td className={TD}>
                <PermissionBadge permission={tool.permission} />
                <div className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                  {tool.permission === 'ask' ? 'Waits for your approval' : tool.permission === 'deny' ? 'Never runs' : tool.permission === 'allow' ? 'Runs without asking' : 'Tool default'}
                </div>
              </td>
              <td className={TD}>
                <span className="text-zinc-600 dark:text-zinc-400">{tool.description}</span>
              </td>
            </tr>
          ))}
          {agent.claude_code_tools.map((name) => (
            <tr key={`cc-${name}`}>
              <td className={TD}>
                <Mono>claude_code.{name}</Mono>
              </td>
              <td className={TD}>—</td>
              <td className={TD}>
                <PermissionBadge permission={agent.permissions[`claude_code.${name}`] ?? null} />
              </td>
              <td className={TD}>
                <span className="text-zinc-600 dark:text-zinc-400">Claude Code built-in tool (claude-code provider only)</span>
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
    </Card>
  );
}

function InstructionsTab({ agent }: { agent: Agent }) {
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <Card>
        <CardHeader title="Instructions" description="System prompt; the platform appends its non-negotiable operating rules." />
        <CardBody>
          <CodeBlock maxHeight="max-h-[36rem]" copy>
            {agent.instructions}
          </CodeBlock>
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Output schema" description="The agent must submit a final_answer that validates against it." />
        <CardBody>
          {agent.output_schema ? (
            <JsonBlock value={agent.output_schema} maxHeight="max-h-[36rem]" copy />
          ) : (
            <p className="text-sm text-zinc-500">No schema: the agent answers with free text.</p>
          )}
        </CardBody>
      </Card>
    </div>
  );
}

const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

function OverridesEditor({ agent, onSaved }: { agent: Agent; onSaved: (data: AgentDetailResponse) => void }) {
  const tools = useQuery({ queryKey: qk.tools, queryFn: listTools, staleTime: 60_000 });
  const engines = useEngines();
  const toolDefaults = new Map((tools.data?.items ?? []).map((t) => [t.name, t]));
  const toolNames = useMemo(
    () => [...agent.tools, ...agent.claude_code_tools.map((name) => `claude_code.${name}`)],
    [agent.tools, agent.claude_code_tools],
  );
  const initial = useMemo(
    () => ({
      provider: agent.provider,
      model: agent.model ?? '',
      effort: (agent.effort ?? '') as Effort | '',
      limits: Object.fromEntries(AGENT_LIMIT_KEYS.map(({ key }) => [key, agent.limits[key] !== undefined ? String(agent.limits[key]) : ''])),
      permissions: Object.fromEntries(toolNames.map((name) => [name, agent.permissions[name] ?? ''])) as Record<string, Permission | ''>,
    }),
    [agent, toolNames],
  );
  const [form, setForm] = useState(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => setForm(initial), [initial]);

  const save = useMutation({
    mutationFn: (overrides: AgentOverrides) => patchAgent(agent.id, { overrides }),
    onSuccess: (data) => {
      setNotice('Saved. New runs use this configuration; the revision changed.');
      onSaved(data);
    },
  });
  const reset = useMutation({
    mutationFn: () => resetAgent(agent.id),
    onSuccess: (data) => {
      setNotice('Overrides removed: the file definition applies again.');
      onSaved(data);
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    setNotice(null);
    const nextErrors: Record<string, string> = {};
    const limits: Record<string, number> = {};
    for (const { key, float } of AGENT_LIMIT_KEYS) {
      const raw = form.limits[key]?.trim() ?? '';
      if (!raw) continue;
      const value = Number(raw);
      if (!Number.isFinite(value) || value <= 0) nextErrors[key] = 'Positive number required.';
      else if (!float && !Number.isInteger(value)) nextErrors[key] = 'Whole number required.';
      else limits[key] = value;
    }
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length) return;
    const permissions = Object.fromEntries(Object.entries(form.permissions).filter(([, v]) => v)) as Record<string, Permission>;
    const overrides: AgentOverrides = {};
    if (form.provider !== agent.provider) overrides.provider = form.provider;
    if ((form.model.trim() || null) !== (agent.model ?? null)) overrides.model = form.model.trim() || null;
    if ((form.effort || null) !== (agent.effort ?? null)) overrides.effort = form.effort || null;
    if (JSON.stringify(sortKeys(limits)) !== JSON.stringify(sortKeys(agent.limits))) overrides.limits = limits;
    if (JSON.stringify(sortKeys(permissions)) !== JSON.stringify(sortKeys(agent.permissions))) overrides.permissions = permissions;
    if (Object.keys(overrides).length === 0) {
      setNotice('Nothing changed.');
      return;
    }
    save.mutate(overrides);
  }

  // Platform default, Claude Code, the installed ACP agents, then the scripted test double; the current value is
  // always offered so the select never shows something else.
  const acp = orderedEngines(engines.data?.items)
    .filter((e) => !e.builtin && e.installed)
    .map((e) => ({ value: e.provider, label: e.name }));
  const providers: { value: string; label: string }[] = [
    { value: 'default', label: providerLabel('default') },
    { value: 'claude-code', label: providerLabel('claude-code') },
    ...acp,
    { value: 'scripted', label: SCRIPTED_LABEL },
  ];
  if (!providers.some((p) => p.value === form.provider)) providers.push({ value: form.provider, label: providerLabel(form.provider) });

  const overridden = Object.keys(agent.overrides);
  return (
    <form onSubmit={submit} className="space-y-4" aria-label="Agent configuration">
      <Alert tone="gray">
        {agent.source === 'file'
          ? 'Changes are stored as owner overrides on top of the TOML file (the file is not modified). Reset removes them.'
          : 'This custom agent is stored in the database; changes update its definition.'}
        {overridden.length > 0 && (
          <span className="mt-1 flex flex-wrap items-center gap-1">
            Overridden now:{' '}
            {overridden.map((key) => (
              <Badge key={key} tone="amber">
                {key}
              </Badge>
            ))}
          </span>
        )}
      </Alert>
      <Card>
        <CardHeader title="Model" />
        <CardBody className="grid gap-4 sm:grid-cols-3">
          <Field label="Provider" htmlFor="ov-provider" hint="“Platform default” follows Settings → Providers.">
            <Select id="ov-provider" value={form.provider} onChange={(e) => setForm({ ...form, provider: e.target.value as ProviderName })}>
              {providers.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Model" htmlFor="ov-model" hint="Empty: the provider's default model.">
            <Input id="ov-model" mono value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} placeholder="provider default" />
          </Field>
          <Field label="Effort" htmlFor="ov-effort">
            <Select id="ov-effort" value={form.effort} onChange={(e) => setForm({ ...form, effort: e.target.value as Effort | '' })}>
              <option value="">Not set</option>
              {EFFORTS.map((e) => (
                <option key={e} value={e}>
                  {e}
                </option>
              ))}
            </Select>
          </Field>
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Limits" description="Empty: the platform limit from Settings applies." />
        <CardBody className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-5">
          {AGENT_LIMIT_KEYS.map(({ key, label }) => (
            <Field key={key} label={label} htmlFor={`ov-limit-${key}`} error={errors[key]}>
              <Input
                id={`ov-limit-${key}`}
                inputMode="decimal"
                value={form.limits[key] ?? ''}
                placeholder="platform"
                aria-invalid={!!errors[key]}
                onChange={(e) => setForm({ ...form, limits: { ...form.limits, [key]: e.target.value } })}
              />
            </Field>
          ))}
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Permissions" description="Agent layer. Global overrides still win, and a deny anywhere wins." />
        {toolNames.length === 0 ? (
          <CardBody>
            <p className="text-sm text-zinc-500">No tools.</p>
          </CardBody>
        ) : (
          <Table>
            <thead>
              <tr>
                <th className={TH}>Tool</th>
                <th className={TH}>Default</th>
                <th className={TH}>Agent permission</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {toolNames.map((name) => {
                const detail = agent.tools_detail.find((t) => t.name === name);
                return (
                  <tr key={name}>
                    <td className={TD}>
                      <Mono>{name}</Mono> {detail?.risk && <RiskBadge risk={detail.risk} />}
                    </td>
                    <td className={TD}>
                      {toolDefaults.get(name) ? (
                        <span className="inline-flex items-center gap-1.5">
                          <PermissionBadge permission={toolDefaults.get(name)!.default_permission} />
                          {toolDefaults.get(name)!.global_permission && (
                            <span className="text-xs text-zinc-500">global: {toolDefaults.get(name)!.global_permission}</span>
                          )}
                        </span>
                      ) : (
                        <span className="text-xs text-zinc-500">{name.startsWith('claude_code.') ? 'by risk' : '—'}</span>
                      )}
                    </td>
                    <td className={TD}>
                      <label htmlFor={`ov-perm-${name}`} className="sr-only">
                        Permission for {name}
                      </label>
                      <Select
                        id={`ov-perm-${name}`}
                        className="w-40"
                        value={form.permissions[name] ?? ''}
                        onChange={(e) => setForm({ ...form, permissions: { ...form.permissions, [name]: e.target.value as Permission | '' } })}
                      >
                        <option value="">Inherit</option>
                        <option value="allow">allow</option>
                        <option value="ask">ask (approval)</option>
                        <option value="deny">deny</option>
                      </Select>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Card>
      {notice && <Alert tone="green">{notice}</Alert>}
      {(save.isError || reset.isError) && <ErrorState compact error={save.error ?? reset.error} title="Not saved" />}
      <div className="flex flex-wrap justify-end gap-2">
        {agent.source === 'file' && (
          <Button
            icon={<RotateCcw className="h-4 w-4" />}
            disabled={overridden.length === 0}
            loading={reset.isPending}
            onClick={() => reset.mutate()}
          >
            Reset to file definition
          </Button>
        )}
        <Button type="submit" variant="primary" icon={<Save className="h-4 w-4" />} loading={save.isPending}>
          Save configuration
        </Button>
      </div>
    </form>
  );
}

function sortKeys(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
}

function HistoryTab({ runs }: { runs: AgentDetailResponse['recent_runs'] }) {
  if (runs.length === 0) return <EmptyState title="This agent has not run yet" />;
  return (
    <Card>
      <CardHeader title="Recent runs" description="Last 25, including runs as a delegate or team member." />
      <Table>
        <thead>
          <tr>
            <th className={TH}>Task</th>
            <th className={TH}>Status</th>
            <th className={TH}>Started</th>
            <th className={TH}>Duration</th>
            <th className={TH}>Steps</th>
            <th className={TH}>Tokens</th>
            <th className={TH}>Cost</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {runs.map((run) => (
            <tr key={run.id} className="hover:bg-zinc-50 dark:hover:bg-zinc-800/40">
              <td className={TD}>
                <Link to={`/runs/${run.id}`} className="text-zinc-900 hover:underline dark:text-zinc-100">
                  {truncate(run.task, 90)}
                </Link>
                {run.parent_run_id && <Badge className="ml-2">child</Badge>}
              </td>
              <td className={TD}>
                <StatusBadge status={run.status} />
              </td>
              <td className={`${TD} whitespace-nowrap`}>{formatDateTime(run.started_at ?? run.created_at)}</td>
              <td className={`${TD} tabular-nums`}>{formatDuration(run.duration_s)}</td>
              <td className={`${TD} tabular-nums`}>{run.steps}</td>
              <td className={`${TD} tabular-nums`}>{formatTokens(run.input_tokens + run.output_tokens)}</td>
              <td className={`${TD} tabular-nums`}>{formatCost(run.cost_usd)}</td>
            </tr>
          ))}
        </tbody>
      </Table>
    </Card>
  );
}

function ExportTab({ agent, toml }: { agent: Agent; toml: string }) {
  const download = () => {
    const url = URL.createObjectURL(new Blob([toml], { type: 'application/toml' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `${agent.id}.toml`;
    link.click();
    URL.revokeObjectURL(url);
  };
  return (
    <Card>
      <CardHeader
        title="TOML export"
        description="The effective definition (overrides included), ready to commit to the agents directory."
        actions={
          <>
            <CopyButton text={toml} size="sm" />
            <Button icon={<Download className="h-4 w-4" />} onClick={download}>
              Download {agent.id}.toml
            </Button>
          </>
        }
      />
      <CardBody>
        <CodeBlock maxHeight="max-h-[40rem]">{toml}</CodeBlock>
      </CardBody>
    </Card>
  );
}

function DefinitionEditor({ agent, onSaved }: { agent: Agent; onSaved: (data: AgentDetailResponse) => void }) {
  const [text, setText] = useState(() => stringify(definitionOf(agent)));
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({ mutationFn: (body: Record<string, unknown>) => replaceAgent(agent.id, body), onSuccess: onSaved });
  function submit(event: FormEvent) {
    event.preventDefault();
    const parsed = parseJson<Record<string, unknown>>(text, 'object', { allowEmpty: false });
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    setError(null);
    save.mutate(parsed.value ?? {});
  }
  return (
    <form onSubmit={submit} className="space-y-3">
      <Field label="Definition (JSON)" htmlFor="def-json" error={error ?? undefined} hint="Validated by the server; the id cannot change.">
        <Textarea id="def-json" mono rows={28} value={text} aria-invalid={!!error} onChange={(e) => setText(e.target.value)} />
      </Field>
      {save.isError && <ErrorState compact error={save.error} title="The server rejected the definition" />}
      {save.isSuccess && <Alert tone="green">Saved.</Alert>}
      <div className="flex justify-end">
        <Button type="submit" variant="primary" icon={<Save className="h-4 w-4" />} loading={save.isPending}>
          Save definition
        </Button>
      </div>
    </form>
  );
}

/** The output an agent promises: the shared envelope (status, summary, issues) then its own fields. */
function OutputContract({ agent }: { agent: Agent }) {
  const fields = outputContract(agent.output_schema as Record<string, unknown> | null);
  if (fields.length === 0) {
    return (
      <div>
        <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-zinc-500">Output</h3>
        <p className="text-zinc-600 dark:text-zinc-400">Free text: this agent has no structured output contract.</p>
      </div>
    );
  }
  return (
    <div>
      <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-zinc-500">Output contract</h3>
      <p className="mb-1.5 text-xs text-zinc-500 dark:text-zinc-400">
        Every structured answer is validated against this. <Mono>status</Mono> is complete, partial or blocked; <Mono>summary</Mono> and{' '}
        <Mono>issues</Mono> are shared by all agents.
      </p>
      <ul className="divide-y divide-zinc-100 rounded-md border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800" aria-label="Output fields">
        {fields.map((field) => (
          <li key={field.name} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 px-3 py-1.5">
            <Mono className="font-semibold text-zinc-900 dark:text-zinc-100">{field.name}</Mono>
            <Mono className="text-xs text-zinc-500">{truncate(field.type, 60)}</Mono>
            {field.required && <Badge tone="gray">required</Badge>}
            {field.envelope && <Badge tone="accent">shared</Badge>}
            {field.description && <span className="basis-full text-xs text-zinc-600 dark:text-zinc-400">{field.description}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}
