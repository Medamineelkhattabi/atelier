// "Create a project" wizard: about (name) → folder → notes for your team → check and create.
// POST /api/projects; the server re-validates everything and its refusals are shown as they come.

import { useMemo, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronLeft, ChevronRight, FolderKanban, Sparkles } from 'lucide-react';
import { createProject, getWorkspaces, listProjects } from '../api/endpoints';
import { qk } from '../api/keys';
import type { CreateProjectRequest, CreateProjectResponse } from '../api/types';
import { Page } from '../components/Page';
import { Alert, Button, ButtonLink, Card, CardBody, CardHeader, ErrorState, Field, Input, KeyValue, Mono, Textarea } from '../components/ui';
import { useToast } from '../components/toast';
import { useProjectSelection } from '../features/projects/ProjectContext';
import { CONTEXT_TEMPLATE, joinPath, parsePrivatePaths, slugify, validateName, validateWorkspace } from '../features/projects/projectForm';
import { cx } from '../lib/cx';

type Step = 'basics' | 'workspace' | 'brief' | 'review';

const STEPS: { id: Step; label: string }[] = [
  { id: 'basics', label: 'About' },
  { id: 'workspace', label: 'Folder' },
  { id: 'brief', label: 'Notes for your team' },
  { id: 'review', label: 'Check and create' },
];

type Errors = Partial<Record<'name' | 'folder', string>>;

export function ProjectCreatePage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { notify } = useToast();
  const { setProjectId } = useProjectSelection();
  const workspaces = useQuery({ queryKey: qk.workspaces, queryFn: getWorkspaces, staleTime: 30_000 });
  // Archived projects keep their folder: include them in the overlap check.
  const existing = useQuery({ queryKey: qk.projectList(true), queryFn: () => listProjects(true) });

  const [step, setStep] = useState<Step>('basics');
  const [reached, setReached] = useState(0);
  const [name, setName] = useState('');
  const [folderMode, setFolderMode] = useState<'auto' | 'existing'>('auto');
  const [existingPath, setExistingPath] = useState('');
  const [privateText, setPrivateText] = useState('');
  const [context, setContext] = useState('');
  const [errors, setErrors] = useState<Errors>({});
  const [created, setCreated] = useState<CreateProjectResponse | null>(null);

  const roots = useMemo(() => (workspaces.data?.roots ?? []).map((r) => r.root), [workspaces.data]);
  const workspacePath = folderMode === 'existing' ? existingPath.trim() : '';
  const privatePaths = folderMode === 'existing' ? parsePrivatePaths(privateText) : [];
  const autoPreview = roots[0] ? joinPath(roots[0], slugify(name || 'my-project')) : 'a new folder in the allowed location';

  const create = useMutation({
    mutationFn: (body: CreateProjectRequest) => createProject(body),
    onSuccess: (project) => {
      void queryClient.invalidateQueries({ queryKey: qk.projects });
      notify(`Project “${project.name}” created`);
      setCreated(project);
    },
  });

  const index = STEPS.findIndex((s) => s.id === step);

  function validate(target: Step): Errors {
    const next: Errors = {};
    if (target === 'basics') {
      const nameError = validateName(name);
      if (nameError) next.name = nameError;
    }
    if (target === 'workspace' && folderMode === 'existing') {
      if (!workspacePath) next.folder = 'Paste the folder’s address.';
      else {
        const problem = validateWorkspace(workspacePath, roots, existing.data?.items ?? []);
        if (problem) next.folder = problem;
      }
    }
    return next;
  }

  function goTo(target: Step) {
    const targetIndex = STEPS.findIndex((s) => s.id === target);
    if (targetIndex > index) {
      // Moving forward validates every step in between.
      for (let i = index; i < targetIndex; i += 1) {
        const problems = validate(STEPS[i]!.id);
        if (Object.keys(problems).length) {
          setErrors(problems);
          setStep(STEPS[i]!.id);
          return;
        }
      }
    }
    setErrors({});
    setStep(target);
    setReached((r) => Math.max(r, targetIndex));
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (step !== 'review') {
      goTo(STEPS[index + 1]!.id);
      return;
    }
    for (const s of STEPS) {
      const problems = validate(s.id);
      if (Object.keys(problems).length) {
        setErrors(problems);
        setStep(s.id);
        return;
      }
    }
    const body: CreateProjectRequest = { name: name.trim() };
    if (workspacePath) body.workspace = workspacePath;
    if (privatePaths.length) body.private_paths = privatePaths;
    if (context.trim()) body.context = context.trim();
    create.mutate(body);
  }

  if (created) {
    const start = () => {
      setProjectId(created.id);
      navigate(`/?project=${encodeURIComponent(created.id)}`);
    };
    return (
      <Page title="Project created" back={{ to: '/projects', label: 'My Projects' }}>
        <Card>
          <CardHeader title={created.name} icon={<FolderKanban className="h-4 w-4" />} />
          <CardBody className="space-y-4">
            <KeyValue
              items={[
                { label: 'Folder', value: <Mono className="break-all">{created.workspace}</Mono> },
                { label: 'Notes for your team', value: created.context ? 'Written' : 'None yet' },
              ]}
            />
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" icon={<Sparkles className="h-4 w-4" />} onClick={start}>
                Start a task in this project
              </Button>
              <ButtonLink to={`/projects/${encodeURIComponent(created.id)}`}>Open the project</ButtonLink>
            </div>
          </CardBody>
        </Card>
      </Page>
    );
  }

  return (
    <Page title="Create a project" back={{ to: '/projects', label: 'My Projects' }} description="Only the name is required.">
      <form onSubmit={submit} noValidate aria-label="Create a project" className="mx-auto max-w-3xl space-y-4">
        <ol className="flex flex-wrap gap-1.5" aria-label="Steps">
          {STEPS.map((s, i) => {
            const current = s.id === step;
            const done = i < index;
            return (
              <li key={s.id}>
                <button
                  type="button"
                  aria-current={current ? 'step' : undefined}
                  disabled={i > reached}
                  onClick={() => goTo(s.id)}
                  className={cx(
                    'inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 disabled:cursor-not-allowed disabled:opacity-50',
                    current
                      ? 'bg-accent-600 text-white dark:bg-accent-500'
                      : done
                        ? 'bg-accent-50 text-accent-800 dark:bg-accent-950 dark:text-accent-200'
                        : 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300',
                  )}
                >
                  {done ? <Check className="h-3 w-3" aria-hidden /> : <span className="tabular-nums">{i + 1}</span>}
                  {s.label}
                </button>
              </li>
            );
          })}
        </ol>

        <Card>
          {step === 'basics' && (
            <>
              <CardHeader title="About the project" />
              <CardBody>
                <Field label="Name" htmlFor="project-name" error={errors.name} required>
                  <Input id="project-name" value={name} aria-invalid={!!errors.name} maxLength={120} onChange={(e) => setName(e.target.value)} placeholder="Customer portal" />
                </Field>
              </CardBody>
            </>
          )}

          {step === 'workspace' && (
            <>
              <CardHeader title="Project folder" description="Your team works only inside this folder." />
              <CardBody className="space-y-4">
                <fieldset className="space-y-2">
                  <legend className="sr-only">Folder</legend>
                  <label className="flex items-start gap-2 text-sm">
                    <input type="radio" name="folder-mode" className="mt-1" checked={folderMode === 'auto'} onChange={() => setFolderMode('auto')} />
                    <span>
                      <span className="font-medium text-zinc-900 dark:text-zinc-100">New folder</span>
                      <Mono className="block break-all text-xs text-zinc-500 dark:text-zinc-400">{autoPreview}</Mono>
                    </span>
                  </label>
                  <label className="flex items-start gap-2 text-sm">
                    <input type="radio" name="folder-mode" className="mt-1" checked={folderMode === 'existing'} onChange={() => setFolderMode('existing')} />
                    <span className="font-medium text-zinc-900 dark:text-zinc-100">A folder I already have</span>
                  </label>
                </fieldset>
                {folderMode === 'existing' && (
                  <div className="space-y-3 rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
                    <Field label="Folder address" htmlFor="project-path" error={errors.folder} hint="Copy it from the File Explorer address bar.">
                      <Input
                        id="project-path"
                        mono
                        value={existingPath}
                        placeholder="C:\\Projects\\my-app"
                        aria-invalid={!!errors.folder}
                        onChange={(e) => setExistingPath(e.target.value)}
                      />
                    </Field>
                    <Field label="Private folders (optional)" htmlFor="project-private" hint="One per line. Your team never opens them.">
                      <Textarea id="project-private" rows={3} mono value={privateText} placeholder={'backups\nlogs'} onChange={(e) => setPrivateText(e.target.value)} />
                    </Field>
                  </div>
                )}
              </CardBody>
            </>
          )}

          {step === 'brief' && (
            <>
              <CardHeader title="Project notes for your team" description="Read before every task in this project." />
              <CardBody className="space-y-3">
                <Field label="Notes (optional)" htmlFor="project-context" hint="Purpose, how things are done, limits. Never passwords.">
                  <Textarea id="project-context" rows={10} maxLength={20000} value={context} onChange={(e) => setContext(e.target.value)} />
                </Field>
                {!context.trim() && (
                  <Button size="xs" onClick={() => setContext(CONTEXT_TEMPLATE)}>
                    Start from an example outline
                  </Button>
                )}
              </CardBody>
            </>
          )}

          {step === 'review' && (
            <>
              <CardHeader title="Check and create" description="Nothing is created until you confirm." />
              <CardBody className="space-y-4">
                <KeyValue
                  items={[
                    { label: 'Name', value: name.trim() },
                    { label: 'Folder', value: <Mono className="break-all">{workspacePath || `${autoPreview} (new)`}</Mono> },
                    ...(privatePaths.length ? [{ label: 'Private folders', value: privatePaths.join(', ') }] : []),
                    { label: 'Notes for your team', value: context.trim() ? `${context.trim().split('\n').length} lines` : 'None' },
                  ]}
                />
                {create.isError && (
                  <div className="space-y-2">
                    <ErrorState compact error={create.error} title="The project was not created." />
                    <Button size="xs" onClick={() => goTo('workspace')}>
                      Change the folder
                    </Button>
                  </div>
                )}
                {!context.trim() && <Alert tone="amber">No notes yet: you can add them later from the project page.</Alert>}
              </CardBody>
            </>
          )}
        </Card>

        <div className="flex items-center justify-between gap-2">
          <Button icon={<ChevronLeft className="h-4 w-4" />} disabled={index === 0} onClick={() => goTo(STEPS[index - 1]!.id)}>
            Back
          </Button>
          {step === 'review' ? (
            <Button type="submit" variant="primary" size="md" icon={<FolderKanban className="h-4 w-4" />} loading={create.isPending}>
              Create the project
            </Button>
          ) : (
            <Button type="submit" variant="primary">
              Next <ChevronRight className="h-4 w-4" aria-hidden />
            </Button>
          )}
        </div>
      </form>
    </Page>
  );
}
