// "Which project is this for?": existing projects, "No particular project", or a new one created inline.

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { FolderPlus } from 'lucide-react';
import { createProject } from '../../api/endpoints';
import { qk } from '../../api/keys';
import { Button, ErrorState, Field, Input, Select, Textarea } from '../../components/ui';
import { useProjects } from '../projects/ProjectContext';

const NEW = '__new__';

export function ProjectChoice({ value, onChange }: { value: string; onChange: (projectId: string) => void }) {
  const projects = useProjects();
  const items = projects.data?.items ?? [];
  const [creating, setCreating] = useState(false);
  const known = !value || items.some((p) => p.id === value);
  return (
    <div className="space-y-2">
      <Field
        label="Which project is this for?"
        htmlFor="home-project"
        hint={projects.isError ? 'Projects could not be listed: the task will have no project.' : undefined}
      >
        <Select
          id="home-project"
          value={creating ? NEW : value}
          onChange={(event) => {
            if (event.target.value === NEW) {
              setCreating(true);
              return;
            }
            setCreating(false);
            onChange(event.target.value);
          }}
        >
          <option value="">No particular project</option>
          {items.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
          {!known && <option value={value}>{projects.isPending ? 'Loading your projects…' : 'A project that is no longer available'}</option>}
          <option value={NEW}>New project…</option>
        </Select>
      </Field>
      {creating && (
        <NewProject
          onCancel={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            onChange(id);
          }}
        />
      )}
    </div>
  );
}

function NewProject({ onCreated, onCancel }: { onCreated: (id: string) => void; onCancel: () => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => nameRef.current?.focus(), []);
  const create = useMutation({
    mutationFn: () => createProject({ name: name.trim(), context: notes.trim() || undefined }),
    onSuccess: async (project) => {
      await queryClient.invalidateQueries({ queryKey: qk.projects });
      onCreated(project.id);
    },
  });
  const submit = () => {
    if (name.trim().length < 2) {
      setError('Give the project a name of at least 2 characters.');
      nameRef.current?.focus();
      return;
    }
    setError(null);
    create.mutate();
  };
  // Not a <form>: this sits inside the request form, and Enter must create the project, not start the task.
  const onEnter = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      submit();
    }
  };
  return (
    <div role="group" aria-labelledby="new-project-title" className="space-y-3 rounded-md border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-950/50">
      <p id="new-project-title" className="flex items-center gap-1.5 text-sm font-medium text-zinc-900 dark:text-zinc-100">
        <FolderPlus className="h-4 w-4" aria-hidden />
        New project
      </p>
      <Field label="Project name" htmlFor="new-project-name" error={error ?? undefined} required>
        <Input
          ref={nameRef}
          id="new-project-name"
          value={name}
          maxLength={120}
          placeholder="e.g. Kitchen renovation"
          aria-invalid={!!error}
          onKeyDown={onEnter}
          onChange={(event) => setName(event.target.value)}
        />
      </Field>
      <Field label="Notes for your team (optional)" htmlFor="new-project-notes">
        <Textarea
          id="new-project-notes"
          rows={3}
          value={notes}
          maxLength={20_000}
          placeholder="Goals, rules, people involved…"
          onChange={(event) => setNotes(event.target.value)}
        />
      </Field>
      {create.isError && <ErrorState compact error={create.error} title="The project was not created." />}
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" loading={create.isPending} onClick={submit}>
          Create project
        </Button>
        <Button variant="ghost" onClick={onCancel} disabled={create.isPending}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
