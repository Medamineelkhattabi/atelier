// One project, in plain words: an overview (its recent work, start a task in it, whether file edits
// need approval), the notes the team reads before every task, its passwords & keys, and an
// Advanced tab (folder, private folders, archive / delete).

import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, ArchiveRestore, ArrowRight, NotebookPen, Pencil, Save, Sparkles, Trash2 } from 'lucide-react';
import { deleteProject, getProject, listAgents, listRuns, patchProject } from '../api/endpoints';
import { ApiError, errorMessage } from '../api/client';
import { qk } from '../api/keys';
import type { Project, ProjectPatch, RunListParams } from '../api/types';
import { Page } from '../components/Page';
import {
  Alert,
  Badge,
  Button,
  ButtonLink,
  Card,
  CardBody,
  CardHeader,
  ConfirmDialog,
  CopyButton,
  EmptyState,
  ErrorState,
  Field,
  Input,
  KeyValue,
  LoadingState,
  Mono,
  Spinner,
  Tabs,
  Textarea,
  Toggle,
} from '../components/ui';
import { useToast } from '../components/toast';
import { useProjectSelection } from '../features/projects/ProjectContext';
import { ProjectSecrets } from '../features/projects/ProjectSecrets';
import { CONTEXT_TEMPLATE, parsePrivatePaths, validateName } from '../features/projects/projectForm';
import { formatDateTime, formatRelative, truncate } from '../lib/format';
import { memberName, plainTaskText, workStatus } from '../lib/plain';

type Tab = 'overview' | 'notes' | 'secrets' | 'advanced';

const TABS: { id: Tab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'notes', label: 'Notes for your team' },
  { id: 'secrets', label: 'Passwords & keys' },
  { id: 'advanced', label: 'Advanced' },
];

/** Former tab names still open the right place. */
const OLD_TABS: Record<string, Tab> = { templates: 'advanced', 'claude-code': 'advanced', brief: 'notes' };

const BACK = { to: '/projects', label: 'My Projects' };

export function ProjectDetailPage() {
  const { projectId = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { notify } = useToast();
  const { projectId: selected, setProjectId } = useProjectSelection();
  const query = useQuery({ queryKey: qk.project(projectId), queryFn: () => getProject(projectId), enabled: !!projectId });
  const requested = params.get('tab') ?? '';
  const tab: Tab = TABS.some((t) => t.id === requested) ? (requested as Tab) : (OLD_TABS[requested] ?? 'overview');
  const [confirm, setConfirm] = useState<'delete' | 'archive' | null>(null);

  const refresh = (project?: Project) => {
    if (project) queryClient.setQueryData(qk.project(projectId), project);
    void queryClient.invalidateQueries({ queryKey: qk.projects });
  };
  const archive = useMutation({
    mutationFn: (archived: boolean) => patchProject(projectId, { archived }),
    onSuccess: (project) => {
      refresh(project);
      if (project.archived && selected === project.id) setProjectId(null);
      notify(project.archived ? `“${project.name}” archived: no new task can start in it` : `“${project.name}” restored`);
    },
    onSettled: () => setConfirm(null),
  });
  const remove = useMutation({
    mutationFn: () => deleteProject(projectId),
    onSuccess: () => {
      if (selected === projectId) setProjectId(null);
      void queryClient.invalidateQueries({ queryKey: qk.projects });
      notify('Project deleted');
      navigate('/projects');
    },
  });

  if (query.isPending) {
    return (
      <Page title="Project" back={BACK}>
        <LoadingState />
      </Page>
    );
  }
  if (query.isError) {
    const missing = query.error instanceof ApiError && query.error.status === 404;
    return (
      <Page title="Project" back={BACK}>
        {missing ? (
          <EmptyState title="This project does not exist" action={<ButtonLink to="/projects">See my projects</ButtonLink>} />
        ) : (
          <ErrorState
            error={query.error}
            title="This project could not be loaded."
            onRetry={() => void query.refetch()}
          />
        )}
      </Page>
    );
  }
  const project = query.data;
  const hasRuns = remove.isError && remove.error instanceof ApiError && remove.error.status === 409;
  const setTab = (id: Tab) => setParams({ tab: id }, { replace: true });

  return (
    <Page
      title={project.name}
      back={BACK}
      actions={
        project.archived ? (
          <Button icon={<ArchiveRestore className="h-4 w-4" />} loading={archive.isPending} onClick={() => archive.mutate(false)}>
            Restore project
          </Button>
        ) : (
          <ButtonLink to={`/?project=${encodeURIComponent(project.id)}`} variant="primary" icon={<Sparkles className="h-4 w-4" />}>
            Start a task in this project
          </ButtonLink>
        )
      }
    >
      <div className="space-y-4">
        {project.archived && (
          <Alert tone="gray" icon={<Archive className="h-4 w-4" />} title="Archived: no new task can start in it." />
        )}
        {archive.isError && <ErrorState compact error={archive.error} title="Not changed. Try again." />}
        <Tabs<Tab> label="Project sections" value={tab} onChange={setTab} tabs={TABS} />
        {tab === 'overview' && <OverviewTab project={project} onSaved={refresh} onOpenNotes={() => setTab('notes')} />}
        {tab === 'notes' && <NotesTab project={project} onSaved={refresh} />}
        {tab === 'secrets' && <ProjectSecrets project={project} />}
        {tab === 'advanced' && (
          <AdvancedTab
            project={project}
            onArchive={() => setConfirm('archive')}
            onRestore={() => archive.mutate(false)}
            restoring={archive.isPending}
            onDelete={() => setConfirm('delete')}
          />
        )}
      </div>

      <ConfirmDialog
        open={confirm === 'archive'}
        title={`Archive “${project.name}”?`}
        confirmLabel="Archive project"
        loading={archive.isPending}
        onConfirm={() => archive.mutate(true)}
        onCancel={() => setConfirm(null)}
      >
        No new task can start in it. Everything is kept, and you can restore it at any time.
      </ConfirmDialog>
      <ConfirmDialog
        open={confirm === 'delete'}
        title={`Delete “${project.name}”?`}
        confirmLabel="Delete project"
        danger
        loading={remove.isPending}
        onConfirm={() => remove.mutate()}
        onCancel={() => {
          setConfirm(null);
          remove.reset();
        }}
      >
        <p>The project, its notes and its passwords are removed. The folder and its files stay on this computer. This cannot be undone.</p>
        <p className="mt-1">A project that already has work cannot be deleted: archive it instead.</p>
        {remove.isError && (
          <div className="mt-2 space-y-2">
            <p className="text-red-600 dark:text-red-400">{errorMessage(remove.error)}</p>
            {hasRuns && !project.archived && (
              <Button
                size="xs"
                icon={<Archive className="h-3.5 w-3.5" />}
                onClick={() => {
                  remove.reset();
                  archive.mutate(true);
                }}
              >
                Archive it instead
              </Button>
            )}
          </div>
        )}
      </ConfirmDialog>
    </Page>
  );
}

// ------------------------------------------------------------------ overview

function OverviewTab({ project, onSaved, onOpenNotes }: { project: Project; onSaved: (project: Project) => void; onOpenNotes: () => void }) {
  const [editing, setEditing] = useState(false);
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="min-w-0 space-y-4">
        <RecentWork project={project} />
      </div>
      <aside className="min-w-0 space-y-4">
        <Card>
          <CardHeader
            title="About this project"
            actions={
              !editing && (
                <Button size="xs" variant="ghost" icon={<Pencil className="h-3.5 w-3.5" />} onClick={() => setEditing(true)}>
                  Edit
                </Button>
              )
            }
          />
          <CardBody>
            {editing ? (
              <DetailsForm project={project} onSaved={onSaved} onDone={() => setEditing(false)} />
            ) : (
              <KeyValue
                items={[
                  { label: 'Name', value: project.name },
                  { label: 'Status', value: project.archived ? 'Archived' : 'Active' },
                  { label: 'Created', value: formatDateTime(project.created_at) },
                ]}
              />
            )}
          </CardBody>
        </Card>
        <TrustEdits project={project} onSaved={onSaved} />
        {project.watch?.available && <WatchApp project={project} onSaved={onSaved} />}
        <Card>
          <CardHeader title="Notes for your team" icon={<NotebookPen className="h-4 w-4" />} />
          <CardBody className="space-y-2 text-sm text-zinc-700 dark:text-zinc-300">
            {project.context.trim() ? (
              <p>Written, read before every task.</p>
            ) : (
              <p className="text-amber-800 dark:text-amber-300">Not written yet.</p>
            )}
            {project.claude_memory && (
              <p title={project.claude_memory.folder}>
                Your team also uses your Claude Code memory for this folder ({project.claude_memory.notes} notes).
              </p>
            )}
            <Button size="xs" onClick={onOpenNotes}>
              {project.context.trim() ? 'Read or change the notes' : 'Write the notes'}
            </Button>
          </CardBody>
        </Card>
      </aside>
    </div>
  );
}

function RecentWork({ project }: { project: Project }) {
  const params: RunListParams = { project_id: project.id, root_only: true, limit: 10 };
  const runs = useQuery({ queryKey: qk.runList(params), queryFn: () => listRuns(params) });
  const agents = useQuery({ queryKey: qk.agents, queryFn: listAgents, staleTime: 60_000 });
  const team = agents.data?.items ?? [];
  return (
    <Card>
      <CardHeader
        title="Recent work in this project"
        description={`${project.stats.runs} task${project.stats.runs === 1 ? '' : 's'} so far${project.stats.active ? ` · ${project.stats.active} in progress` : ''}`}
      />
      {runs.isPending ? (
        <CardBody>
          <Spinner label="Loading recent work" />
        </CardBody>
      ) : runs.isError ? (
        <CardBody>
          <ErrorState compact error={runs.error} title="Recent work could not be loaded." onRetry={() => void runs.refetch()} />
        </CardBody>
      ) : runs.data.items.length === 0 ? (
        <EmptyState
          title="Nothing yet"
          action={
            !project.archived && (
              <ButtonLink to={`/?project=${encodeURIComponent(project.id)}`} variant="primary" icon={<Sparkles className="h-4 w-4" />}>
                Start a task in this project
              </ButtonLink>
            )
          }
        />
      ) : (
        <ul className="divide-y divide-zinc-100 dark:divide-zinc-800" aria-label="Recent work in this project">
          {runs.data.items.map((run) => {
            const status = workStatus(run.status);
            return (
              <li key={run.id}>
                <Link
                  to={`/workspace/${encodeURIComponent(run.id)}`}
                  className="block px-4 py-2.5 hover:bg-zinc-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-500 dark:hover:bg-zinc-800/50"
                >
                  <span className="block text-sm text-zinc-900 dark:text-zinc-100">{truncate(plainTaskText(run.task) || 'Untitled task', 140)}</span>
                  <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-zinc-500 dark:text-zinc-400">
                    <Badge tone={status.tone} dot>
                      {status.label}
                    </Badge>
                    <span>{run.kind === 'team' ? run.team_name || 'Your AI team' : memberName(run.agent_id, team)}</span>
                    <span>{formatRelative(run.created_at)}</span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      {(runs.data?.items.length ?? 0) > 0 && (
        <div className="border-t border-zinc-100 px-4 py-2.5 dark:border-zinc-800">
          <Link
            to={`/work?project=${encodeURIComponent(project.id)}`}
            className="inline-flex items-center gap-1 text-xs font-medium text-accent-700 hover:underline dark:text-accent-300"
          >
            All the work of this project <ArrowRight className="h-3.5 w-3.5" aria-hidden />
          </Link>
        </div>
      )}
    </Card>
  );
}

/** "Work without asking": file edits and commands that only read or test go ahead; anything else still asks. */
function TrustEdits({ project, onSaved }: { project: Project; onSaved: (project: Project) => void }) {
  const { notify } = useToast();
  const save = useMutation({
    mutationFn: (trust: boolean) => patchProject(project.id, { trust_edits: trust }),
    onSuccess: (updated) => {
      onSaved(updated);
      notify(updated.trust_edits ? 'Your team now works here without asking' : 'Your team asks again before editing or running anything here');
    },
  });
  return (
    <Card>
      <CardBody className="space-y-1">
        <Toggle
          checked={!!project.trust_edits}
          onChange={(value) => save.mutate(value)}
          label="Work without asking"
          showLabel
          disabled={save.isPending || project.archived}
        />
        <p className="text-xs text-zinc-500 dark:text-zinc-400">File edits, reading and tests. Anything else still asks.</p>
        {save.isError && <ErrorState compact error={save.error} title="Not changed." />}
      </CardBody>
    </Card>
  );
}

/** "Watch the app": free checks of the running app every 2 minutes, a Windows alert and a read-only diagnosis on a problem. */
function WatchApp({ project, onSaved }: { project: Project; onSaved: (project: Project) => void }) {
  const { notify } = useToast();
  const save = useMutation({
    mutationFn: (on: boolean) => patchProject(project.id, { watch: { on } }),
    onSuccess: (updated) => {
      onSaved(updated);
      notify(updated.watch?.on ? 'Your app is watched: you will be alerted if it breaks' : 'Your app is no longer watched');
    },
  });
  return (
    <Card>
      <CardBody className="space-y-1">
        <Toggle
          checked={!!project.watch?.on}
          onChange={(value) => save.mutate(value)}
          label="Watch the app"
          showLabel
          disabled={save.isPending || project.archived}
        />
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          Checks it every 2 minutes. If it breaks, you get a Windows alert and the Debugger finds the cause without changing anything.
        </p>
        {save.isError && <ErrorState compact error={save.error} title="Not changed." />}
      </CardBody>
    </Card>
  );
}

function DetailsForm({ project, onSaved, onDone }: { project: Project; onSaved: (project: Project) => void; onDone: () => void }) {
  const { notify } = useToast();
  const [name, setName] = useState(project.name);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const patch: ProjectPatch = {};
  if (name.trim() !== project.name) patch.name = name.trim();
  const dirty = Object.keys(patch).length > 0;
  const save = useMutation({
    mutationFn: () => patchProject(project.id, patch),
    onSuccess: (updated) => {
      onSaved(updated);
      notify('Project saved');
      onDone();
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    const next: Record<string, string> = {};
    const nameError = validateName(name);
    if (nameError) next.name = nameError;
    setErrors(next);
    if (Object.keys(next).length) return;
    if (!dirty) return onDone();
    save.mutate();
  }

  return (
    <form onSubmit={submit} noValidate className="space-y-3" aria-label="Edit project details">
      <Field label="Name" htmlFor="project-edit-name" error={errors.name} required>
        <Input id="project-edit-name" value={name} aria-invalid={!!errors.name} maxLength={120} onChange={(e) => setName(e.target.value)} />
      </Field>
      {save.isError && <ErrorState compact error={save.error} title="Not saved." />}
      <div className="flex flex-wrap justify-end gap-2">
        <Button onClick={onDone}>Cancel</Button>
        <Button type="submit" variant="primary" icon={<Save className="h-4 w-4" />} loading={save.isPending}>
          Save
        </Button>
      </div>
    </form>
  );
}

// ------------------------------------------------------------------ notes for your team

function NotesTab({ project, onSaved }: { project: Project; onSaved: (project: Project) => void }) {
  const { notify } = useToast();
  const [context, setContext] = useState(project.context);
  useEffect(() => setContext(project.context), [project.context]);
  const dirty = context !== project.context;
  const save = useMutation({
    mutationFn: () => patchProject(project.id, { context }),
    onSuccess: (updated) => {
      onSaved(updated);
      notify('Notes saved');
    },
  });
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (dirty) save.mutate();
      }}
      className="max-w-4xl"
      aria-label="Notes for your team"
    >
      <Card>
        <CardHeader title="Notes for your team" description="Purpose, how things are done, limits, what done means. Never passwords." />
        <CardBody className="space-y-2">
          <label htmlFor="project-context" className="sr-only">
            Notes for your team
          </label>
          <Textarea
            id="project-context"
            rows={16}
            maxLength={20000}
            value={context}
            onChange={(e) => setContext(e.target.value)}
            placeholder="What the project is for, how things are done here, what the team must never do…"
          />
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-zinc-500 dark:text-zinc-400">
            <span>{context.length.toLocaleString()} / 20,000</span>
            {!context.trim() && (
              <Button size="xs" onClick={() => setContext(CONTEXT_TEMPLATE)}>
                Start from an example outline
              </Button>
            )}
          </div>
          {save.isError && <ErrorState compact error={save.error} title="Not saved. Try again." />}
          <div className="flex items-center justify-end gap-3">
            {!dirty && save.isSuccess && <span className="text-xs text-emerald-700 dark:text-emerald-300">Saved.</span>}
            <Button type="submit" variant="primary" icon={<Save className="h-4 w-4" />} loading={save.isPending} disabled={!dirty}>
              Save notes
            </Button>
          </div>
        </CardBody>
      </Card>
    </form>
  );
}

// ------------------------------------------------------------------ advanced

function AdvancedTab({
  project,
  onArchive,
  onRestore,
  restoring,
  onDelete,
}: {
  project: Project;
  onArchive: () => void;
  onRestore: () => void;
  restoring: boolean;
  onDelete: () => void;
}) {
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title="Project folder" description="Your team works only here." />
        <CardBody className="space-y-2">
          <Mono className="block break-all text-sm">{project.workspace}</Mono>
          <div className="flex flex-wrap items-center gap-2">
            <CopyButton text={project.workspace} label="Copy the folder path" />
            <span className="text-xs text-zinc-500 dark:text-zinc-400">
              Short name: <Mono>{project.id}</Mono> · last changed {formatRelative(project.updated_at)}
            </span>
          </div>
        </CardBody>
      </Card>
      <PrivateFolders project={project} />
      <Card>
        <CardHeader title="Archive or delete" />
        <CardBody className="space-y-3 text-sm text-zinc-700 dark:text-zinc-300">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <p className="min-w-0 flex-1">
              <span className="font-medium text-zinc-900 dark:text-zinc-100">Archive</span>: no new task starts in it; everything is kept.
            </p>
            {project.archived ? (
              <Button icon={<ArchiveRestore className="h-4 w-4" />} loading={restoring} onClick={onRestore}>
                Restore project
              </Button>
            ) : (
              <Button icon={<Archive className="h-4 w-4" />} onClick={onArchive}>
                Archive project
              </Button>
            )}
          </div>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <p className="min-w-0 flex-1">
              <span className="font-medium text-zinc-900 dark:text-zinc-100">Delete</span>: only while it has no work. The folder stays.
            </p>
            <Button variant="danger" icon={<Trash2 className="h-4 w-4" />} onClick={onDelete}>
              Delete project
            </Button>
          </div>
        </CardBody>
      </Card>
    </div>
  );
}

/** Folders and files inside the project that no team member may open (backups, logs, real data). */
function PrivateFolders({ project }: { project: Project }) {
  const queryClient = useQueryClient();
  const { notify } = useToast();
  const [text, setText] = useState((project.private_paths ?? []).join('\n'));
  const save = useMutation({
    mutationFn: () => patchProject(project.id, { private_paths: parsePrivatePaths(text) }),
    onSuccess: (saved) => {
      queryClient.setQueryData(qk.project(project.id), saved);
      void queryClient.invalidateQueries({ queryKey: qk.projects });
      setText((saved.private_paths ?? []).join('\n'));
      notify('Private folders saved');
    },
  });
  const changed = parsePrivatePaths(text).join('\n') !== (project.private_paths ?? []).join('\n');
  return (
    <Card>
      <CardHeader title="Private folders" description="Your team never opens these." />
      <CardBody className="space-y-3">
        <Field label="One per line, inside the project folder" htmlFor="project-private-paths">
          <Textarea id="project-private-paths" rows={4} mono value={text} placeholder={'backups\nlogs'} onChange={(e) => setText(e.target.value)} />
        </Field>
        {save.isError && <ErrorState compact error={save.error} title="Not saved" />}
        <Button size="sm" variant="primary" icon={<Save className="h-4 w-4" />} disabled={!changed} loading={save.isPending} onClick={() => save.mutate()}>
          Save
        </Button>
      </CardBody>
    </Card>
  );
}
