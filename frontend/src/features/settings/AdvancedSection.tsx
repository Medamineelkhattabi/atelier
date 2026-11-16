// Settings › Advanced: everything most people never need to change. Each part is closed until
// opened, with one sentence saying what it is for. Every change is kept in the activity record.

import { useEffect, useId, useRef, useState, type MutableRefObject, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronRight, Trash2 } from 'lucide-react';
import { getHealth, getSystem, getWorkspaces, listAudit, purge } from '../../api/endpoints';
import { qk } from '../../api/keys';
import {
  Alert,
  Button,
  Card,
  CardBody,
  CardHeader,
  ConfirmDialog,
  Disclosure,
  EmptyState,
  ErrorState,
  Field,
  Input,
  JsonBlock,
  KeyValue,
  LoadingState,
  Mono,
} from '../../components/ui';
import { cx } from '../../lib/cx';
import { formatDateTime, formatDuration } from '../../lib/format';
import { SCRIPTED_LABEL } from '../../lib/status';
import { SettingsForm, type SettingField } from './SettingsForm';

export type AdvancedPart = 'ai' | 'limits' | 'safety' | 'folders' | 'history' | 'audit' | 'system';

const PARTS: { id: AdvancedPart; title: string; summary: string; render: () => ReactNode }[] = [
  {
    id: 'ai',
    title: 'Default AI settings',
    summary: 'AI access and Claude model.',
    render: () => <SettingsForm title="Default AI settings" fields={AI_FIELDS} />,
  },
  {
    id: 'limits',
    title: 'Safety limits',
    summary: 'Upper bounds that stop work that runs too long.',
    render: () => <SettingsForm title="Safety limits" description="Defaults; a team member can have its own." fields={LIMIT_FIELDS} />,
  },
  {
    id: 'safety',
    title: 'Websites, commands and email',
    summary: 'Allowed websites, where commands run, email.',
    render: () => <SafetyPart />,
  },
  {
    id: 'folders',
    title: 'Project folders',
    summary: 'Extra folders where projects keep files.',
    render: () => <FoldersPart />,
  },
  {
    id: 'history',
    title: 'History and clean-up',
    summary: 'How long tasks are kept; delete old ones.',
    render: () => <HistoryPart />,
  },
  {
    id: 'audit',
    title: 'Activity record',
    summary: 'Every change made to the platform.',
    render: () => <AuditPart />,
  },
  {
    id: 'system',
    title: 'System information',
    summary: 'Version, health and storage.',
    render: () => <SystemPart />,
  },
];

export const ADVANCED_PARTS: readonly AdvancedPart[] = PARTS.map((p) => p.id);

export function AdvancedSection({ initialPart }: { initialPart?: AdvancedPart | null }) {
  const [open, setOpen] = useState<Set<AdvancedPart>>(() => new Set(initialPart ? [initialPart] : []));
  const target = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!initialPart) return;
    setOpen((current) => new Set(current).add(initialPart));
    target.current?.scrollIntoView?.({ block: 'start' });
  }, [initialPart]);
  return (
    <div className="space-y-3">
      {PARTS.map((part) => (
        <Part
          key={part.id}
          sectionRef={part.id === initialPart ? target : undefined}
          title={part.title}
          summary={part.summary}
          open={open.has(part.id)}
          onToggle={() =>
            setOpen((current) => {
              const next = new Set(current);
              if (next.has(part.id)) next.delete(part.id);
              else next.add(part.id);
              return next;
            })
          }
        >
          {part.render()}
        </Part>
      ))}
    </div>
  );
}

function Part({
  title,
  summary,
  open,
  onToggle,
  children,
  sectionRef,
}: {
  title: string;
  summary: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
  sectionRef?: MutableRefObject<HTMLElement | null>;
}) {
  const id = useId();
  return (
    <section ref={sectionRef} className="scroll-mt-32 rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
      <h3>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={id}
          onClick={onToggle}
          className="flex w-full items-start gap-2 rounded-lg px-4 py-3 text-left hover:bg-zinc-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-500 dark:hover:bg-zinc-800/50"
        >
          <ChevronRight className={cx('mt-0.5 h-4 w-4 shrink-0 text-zinc-500 transition-transform', open && 'rotate-90')} aria-hidden />
          <span className="min-w-0">
            <span className="block text-sm font-semibold text-zinc-900 dark:text-zinc-100">{title}</span>
            <span className="block text-sm font-normal text-zinc-600 dark:text-zinc-400">{summary}</span>
          </span>
        </button>
      </h3>
      {open && (
        <div id={id} className="space-y-4 border-t border-zinc-200 p-4 dark:border-zinc-800">
          {children}
        </div>
      )}
    </section>
  );
}

// ------------------------------------------------------------------ default AI settings

const AI_FIELDS: SettingField[] = [
  {
    key: 'providers.default',
    label: 'AI access for your team',
    kind: 'select',
    hint: 'Used by team members set to “default”. Test mode is scripted.',
    options: [
      { value: 'claude-code', label: 'Your Claude subscription (Claude Code)' },
      { value: 'scripted', label: `Test mode: ${SCRIPTED_LABEL}` },
    ],
  },
  {
    key: 'providers.claude_code.default_model',
    label: 'Claude model',
    kind: 'text',
    nullable: true,
    mono: true,
    placeholder: "your plan's default",
    hint: 'e.g. “sonnet” or “opus”. Empty: your plan’s default.',
  },
  {
    key: 'providers.claude_code.cli_path',
    label: 'Location of the Claude Code program',
    kind: 'text',
    nullable: true,
    mono: true,
    placeholder: 'found automatically',
    hint: 'Only needed when Claude Code is installed somewhere unusual.',
  },
];

// ------------------------------------------------------------------ safety limits

const LIMIT_FIELDS: SettingField[] = [
  { key: 'limits.max_steps', label: 'Rounds of work per step', kind: 'int', min: 1, hint: 'One round: think, then use tools.' },
  { key: 'limits.timeout_s', label: 'Time limit per task (seconds)', kind: 'int', min: 10, hint: 'A task that takes longer is stopped. Time waiting for you is not counted.' },
  { key: 'limits.max_tokens', label: 'AI text per step (tokens)', kind: 'int', min: 1, hint: 'Read and written per step (a token ≈ ¾ word).' },
  {
    key: 'limits.max_cost_usd',
    label: 'Usage budget per step (pay-per-use equivalent, USD)',
    kind: 'float',
    min: 0,
    hint: 'Not billed: an estimate at pay-per-use prices.',
  },
  { key: 'limits.max_output_tokens', label: 'Longest single AI answer (tokens)', kind: 'int', min: 1 },
  { key: 'limits.max_concurrent_runs', label: 'Tasks running at the same time', kind: 'int', min: 1, hint: 'More tasks wait their turn. Applies immediately.' },
  { key: 'limits.max_delegation_depth', label: 'How many times work can be handed on', kind: 'int', min: 0, hint: '0: team members cannot hand work to each other.' },
  { key: 'limits.max_children_per_run', label: 'Parts one team member can hand out', kind: 'int', min: 0 },
  { key: 'limits.max_parallel_members', label: 'Team members working at the same time', kind: 'int', min: 1, hint: 'Each one uses your Claude plan at the same time.' },
  { key: 'limits.provider_retries', label: 'Retries when Claude does not answer', kind: 'int', min: 0 },
  { key: 'limits.approval_timeout_s', label: 'Time to answer an approval (seconds)', kind: 'int', min: 10, hint: 'After this, the request expires and the action is not done.' },
  { key: 'limits.tool_output_chars', label: 'Tool result kept for the AI (characters)', kind: 'int', min: 100, hint: 'Longer results are shortened before the AI reads them.' },
];

// ------------------------------------------------------------------ websites, commands, email

const SAFETY_FIELDS: SettingField[] = [
  {
    key: 'http.allowed_domains',
    label: 'Websites your team may read without asking',
    kind: 'lines',
    hint: 'One per line, for example *.wikipedia.org. Any other website needs your approval.',
  },
  {
    key: 'http.allow_private_network',
    label: 'Allow this computer and your local network',
    kind: 'bool',
    hint: 'Lets web tools reach localhost or home devices.',
  },
  {
    key: 'shell.sandbox',
    label: 'Where commands run',
    kind: 'select',
    options: [
      { value: 'none', label: 'On this computer, inside the project folder' },
      { value: 'docker', label: 'In an isolated Docker container' },
    ],
  },
  { key: 'shell.docker_image', label: 'Docker image for commands', kind: 'text', mono: true, hint: 'Used when commands run in Docker. Use a fixed version tag.' },
  {
    key: 'email.smtp',
    label: 'Email sending (SMTP settings)',
    kind: 'json',
    expect: 'object',
    hint: '{"host", "port", "security": "starttls"|"ssl"|"none", "from", "username", "password_secret": "NAME OF A SAVED PASSWORD", "allowed_recipient_domains": []}',
  },
];

function SafetyPart() {
  return (
    <>
      <p className="text-sm text-zinc-700 dark:text-zinc-300">
        Whether a team member must ask you first is decided in this order: your choice for that tool on{' '}
        <Link to="/tools" className="font-medium text-accent-700 underline dark:text-accent-300">
          Tools &amp; Connections
        </Link>
        , then the team member’s own settings, then the rules below (for example allowed websites), then the tool’s default. A “never” anywhere wins.
      </p>
      <SettingsForm title="Websites, commands and email" fields={SAFETY_FIELDS} />
    </>
  );
}

// ------------------------------------------------------------------ project folders

function FoldersPart() {
  const workspaces = useQuery({ queryKey: qk.workspaces, queryFn: getWorkspaces });
  return (
    <>
      <SettingsForm
        title="Extra folders"
        description="Each folder must already exist."
        fields={[{ key: 'workspaces.roots', label: 'Extra folders, one per line', kind: 'lines', placeholder: 'C:\\Projets\\my-repo' }]}
      />
      <Card>
        <CardHeader title="Folders your team can use" />
        <CardBody>
          {workspaces.isPending ? (
            <LoadingState />
          ) : workspaces.isError ? (
            <ErrorState error={workspaces.error} title="The folders could not be listed. Try again." onRetry={() => void workspaces.refetch()} />
          ) : (
            <div className="space-y-3 text-sm">
              <p className="break-all">
                Used when a task has no project: <Mono>{workspaces.data.default}</Mono>
              </p>
              {workspaces.data.roots.map((root) => (
                <div key={root.root} className="min-w-0">
                  <p className="break-all font-medium">
                    <Mono>{root.root}</Mono>
                  </p>
                  {root.directories.length > 0 ? (
                    <ul className="ml-4 mt-1 list-disc text-xs text-zinc-600 dark:text-zinc-400">
                      {root.directories.map((dir) => (
                        <li key={dir} className="break-all">
                          <Mono>{dir}</Mono>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="ml-4 text-xs text-zinc-600 dark:text-zinc-400">No folders inside yet.</p>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardBody>
      </Card>
    </>
  );
}

// ------------------------------------------------------------------ history and clean-up

function HistoryPart() {
  const queryClient = useQueryClient();
  const [days, setDays] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const run = useMutation({
    mutationFn: (value?: number) => purge(value),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.runs });
      void queryClient.invalidateQueries({ queryKey: qk.dashboard });
    },
    onSettled: () => setConfirm(false),
  });
  const parsedDays = days.trim() === '' ? undefined : Number(days);

  return (
    <>
      <SettingsForm
        title="Keeping finished tasks"
        fields={[
          { key: 'retention.days', label: 'Keep finished tasks for (days)', kind: 'int', min: 1, hint: 'Older ones are removed when you clean up.' },
          {
            key: 'logging.store_tool_outputs',
            label: 'Keep what each tool returned',
            kind: 'bool',
            hint: 'When off, only the size is kept. Passwords are always removed.',
          },
        ]}
      />
      <Card>
        <CardHeader title="Delete old tasks now" description="With their steps and approvals. Project files are kept." />
        <CardBody className="space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Older than (days)" htmlFor="purge-days" hint="Leave empty to use the setting above." error={error ?? undefined}>
              <Input id="purge-days" inputMode="numeric" className="w-40" value={days} onChange={(e) => setDays(e.target.value)} />
            </Field>
            <Button
              variant="danger"
              icon={<Trash2 className="h-4 w-4" />}
              onClick={() => {
                if (parsedDays !== undefined && (!Number.isInteger(parsedDays) || parsedDays < 0 || parsedDays > 3650)) {
                  setError('A whole number between 0 and 3650.');
                  return;
                }
                setError(null);
                setConfirm(true);
              }}
            >
              Delete old tasks…
            </Button>
          </div>
          {run.isError && <ErrorState compact error={run.error} title="Nothing was deleted. Try again." />}
          {run.isSuccess && <Alert tone="green">{run.data.removed_runs === 0 ? 'Nothing was old enough to delete.' : `Deleted ${run.data.removed_runs} item${run.data.removed_runs === 1 ? '' : 's'} (tasks and their steps).`}</Alert>}
        </CardBody>
      </Card>
      <ConfirmDialog
        open={confirm}
        title="Delete old tasks?"
        confirmLabel="Delete permanently"
        danger
        loading={run.isPending}
        onConfirm={() => run.mutate(parsedDays)}
        onCancel={() => setConfirm(false)}
      >
        Finished tasks older than {parsedDays ?? 'the number of days set above'} days are deleted with their steps and approvals. This cannot be undone.
      </ConfirmDialog>
    </>
  );
}

// ------------------------------------------------------------------ activity record

function AuditPart() {
  const audit = useQuery({ queryKey: qk.audit, queryFn: () => listAudit(300) });
  const [filter, setFilter] = useState('');
  if (audit.isPending) return <LoadingState />;
  if (audit.isError) return <ErrorState error={audit.error} title="The activity record could not be loaded. Try again." onRetry={() => void audit.refetch()} />;
  const items = audit.data.items.filter((e) => !filter || `${e.action} ${e.actor} ${e.target ?? ''}`.toLowerCase().includes(filter.toLowerCase()));
  return (
    <>
      <div className="max-w-xs">
        <Field label="Search the record" htmlFor="audit-filter">
          <Input id="audit-filter" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </Field>
      </div>
      {items.length === 0 ? (
        <EmptyState title={filter ? 'Nothing matches' : 'Nothing recorded yet'} />
      ) : (
        <ul className="divide-y divide-zinc-100 rounded-md border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800" aria-label="Activity record, newest first">
          {items.map((entry) => (
            <li key={entry.id} className="space-y-1 px-3 py-2 text-sm">
              <p className="flex flex-wrap items-baseline gap-x-2">
                <Mono className="text-xs font-semibold text-zinc-900 dark:text-zinc-100">{entry.action}</Mono>
                {entry.target && <Mono className="break-all text-xs text-zinc-600 dark:text-zinc-400">{entry.target}</Mono>}
              </p>
              <p className="text-xs text-zinc-600 dark:text-zinc-400">
                {formatDateTime(entry.ts)} · by {entry.actor}
              </p>
              {entry.details && Object.keys(entry.details).length > 0 && (
                <Disclosure summary="Details">
                  <JsonBlock value={entry.details} maxHeight="max-h-48" />
                </Disclosure>
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

// ------------------------------------------------------------------ system information

function SystemPart() {
  const system = useQuery({ queryKey: qk.system, queryFn: getSystem, refetchInterval: 15_000 });
  const health = useQuery({ queryKey: qk.health, queryFn: getHealth, refetchInterval: 15_000 });
  return (
    <div className="space-y-3">
      {health.isPending ? (
        <LoadingState />
      ) : health.isError ? (
        <ErrorState error={health.error} title="The platform’s health could not be checked." />
      ) : (
        <Alert tone={health.data.status === 'ok' ? 'green' : 'red'} title={health.data.status === 'ok' ? 'Everything is working' : 'Something is wrong with the platform’s storage'}>
          Database: {health.data.database} · version <Mono>{health.data.version}</Mono>
        </Alert>
      )}
      {system.isPending ? (
        <LoadingState />
      ) : system.isError ? (
        <ErrorState error={system.error} title="System information could not be loaded." onRetry={() => void system.refetch()} />
      ) : (
        <>
          <KeyValue
            items={[
              { label: 'Version', value: <Mono>{system.data.version}</Mono> },
              { label: 'Running for', value: formatDuration(system.data.uptime_s) },
              { label: 'Tasks running', value: `${system.data.active_runs} (at most ${system.data.max_concurrent_runs} at the same time)` },
              { label: 'Data folder', value: <Mono className="break-all">{system.data.data_dir}</Mono> },
              { label: 'Free disk space', value: `${system.data.disk_free_gb} GB` },
              { label: 'Team member files', value: <Mono className="break-all">{system.data.agents_dir}</Mono> },
            ]}
          />
          <LoadErrors errors={system.data.agent_load_errors} />
        </>
      )}
    </div>
  );
}

function LoadErrors({ errors }: { errors: Record<string, string> }) {
  const entries = Object.entries(errors);
  if (entries.length === 0) return null;
  return (
    <Alert tone="red" title={`${entries.length} team member file${entries.length > 1 ? 's' : ''} could not be read`}>
      <p>Those team members are missing until the file is fixed.</p>
      <ul className="mt-1 space-y-1">
        {entries.map(([file, error]) => (
          <li key={file}>
            <Mono className="font-semibold">{file}</Mono>: <span className="break-words">{error}</span>
          </li>
        ))}
      </ul>
    </Alert>
  );
}
