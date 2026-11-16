// A project's passwords & keys (project-scoped secrets): write-only, like Settings › Secrets. Work in
// a project can use the secrets saved for all projects plus its own, never another project's.

import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Trash2 } from 'lucide-react';
import { deleteSecret, listSecrets, putSecret } from '../../api/endpoints';
import { errorMessage } from '../../api/client';
import { qk } from '../../api/keys';
import type { Project, SecretInfo } from '../../api/types';
import { Alert, Badge, Button, Card, CardBody, CardHeader, ConfirmDialog, EmptyState, ErrorState, Field, Input, LoadingState, Mono, TD, TH, Table } from '../../components/ui';
import { useToast } from '../../components/toast';
import { formatDateTime } from '../../lib/format';

export const SECRET_NAME = /^[A-Z][A-Z0-9_]{1,99}$/;

export function ProjectSecrets({ project }: { project: Project }) {
  const queryClient = useQueryClient();
  const { notify } = useToast();
  const secrets = useQuery({ queryKey: qk.projectSecrets(project.id), queryFn: () => listSecrets(project.id) });
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [toDelete, setToDelete] = useState<string | null>(null);
  const refresh = () => void queryClient.invalidateQueries({ queryKey: qk.secrets });
  const save = useMutation({
    mutationFn: () => putSecret(name, value, project.id),
    onSuccess: (result) => {
      setValue('');
      setName('');
      refresh();
      notify(`${result.name} saved for ${project.name}`);
    },
  });
  const remove = useMutation({
    mutationFn: (secret: string) => deleteSecret(secret, project.id),
    onSuccess: (_result, secret) => {
      refresh();
      notify(`${secret} deleted`);
    },
    onSettled: () => setToDelete(null),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!SECRET_NAME.test(name)) return setError('Use capital letters, digits and _ only, starting with a letter, e.g. GITHUB_TOKEN.');
    if (!value) return setError('Enter the password or key itself.');
    setError(null);
    save.mutate();
  }

  const items = secrets.data?.items ?? [];
  // Items without project_id come from a server that does not scope secrets yet: treat them as global.
  const own = items.filter((s) => s.project_id === project.id);
  const global = items.filter((s) => s.project_id !== project.id);

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <Card>
        <CardHeader
          title="Passwords & keys this project can use"
          description="Your team uses them by name (for example to sign in to a service); the AI never sees the values. They are stored encrypted and never shown again: only a hint is."
        />
        {secrets.isPending ? (
          <LoadingState />
        ) : secrets.isError ? (
          <div className="p-4">
            <ErrorState error={secrets.error} title="The passwords & keys could not be listed. Try again in a moment." onRetry={() => void secrets.refetch()} />
          </div>
        ) : items.length === 0 ? (
          <EmptyState
            icon={<KeyRound className="h-5 w-5" />}
            title="No password or key yet"
            description="Add one with the form. Only work in this project can use it. Most projects need none."
          />
        ) : (
          <Table>
            <thead>
              <tr>
                <th className={TH}>Name</th>
                <th className={TH}>For</th>
                <th className={TH}>Hint</th>
                <th className={TH}>Updated</th>
                <th className={TH}>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {[...own, ...global].map((secret: SecretInfo) => {
                const mine = secret.project_id === project.id;
                return (
                  <tr key={`${secret.project_id ?? 'global'}-${secret.name}`}>
                    <td className={TD}>
                      <Mono className="font-semibold">{secret.name}</Mono>
                    </td>
                    <td className={TD}>{mine ? <Badge tone="accent">This project</Badge> : <Badge tone="gray">All projects</Badge>}</td>
                    <td className={TD}>
                      <Mono className="text-zinc-500">{secret.hint}</Mono>
                    </td>
                    <td className={`${TD} text-xs`}>{formatDateTime(secret.updated_at)}</td>
                    <td className={TD}>
                      {mine && secret.source === 'stored' ? (
                        <Button size="xs" variant="ghost" icon={<Trash2 className="h-3.5 w-3.5" />} onClick={() => setToDelete(secret.name)}>
                          Delete
                        </Button>
                      ) : !mine ? (
                        <Link to="/settings?tab=secrets" className="text-xs text-accent-700 hover:underline dark:text-accent-300">
                          Manage in Settings
                        </Link>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Card>
      <Card>
        <CardHeader title="Add a password or key" description="Saving a name that already exists replaces its value for this project." />
        <CardBody>
          <form onSubmit={submit} className="space-y-3" autoComplete="off">
            <Field label="Name" htmlFor="project-secret-name" hint="The name your team and connections refer to, e.g. GITHUB_TOKEN.">
              <Input id="project-secret-name" mono value={name} onChange={(e) => setName(e.target.value.toUpperCase())} placeholder="DATABASE_URL" />
            </Field>
            <Field label="Password or key" htmlFor="project-secret-value">
              <Input id="project-secret-value" type="password" autoComplete="new-password" value={value} onChange={(e) => setValue(e.target.value)} />
            </Field>
            {error && (
              <p className="text-xs text-red-600 dark:text-red-400" role="alert">
                {error}
              </p>
            )}
            {save.isError && <ErrorState compact error={save.error} title="Not saved. Check the name, then try again." />}
            {save.isSuccess && (
              <Alert tone="green">
                Saved {save.data.name} ({save.data.hint}).
              </Alert>
            )}
            <Button type="submit" variant="primary" icon={<KeyRound className="h-4 w-4" />} loading={save.isPending}>
              Save
            </Button>
          </form>
          <p className="mt-3 text-xs text-zinc-500 dark:text-zinc-400">
            Never put your Claude sign-in here: your team uses your Claude subscription through Claude Code, signed in once in
            Settings.
          </p>
        </CardBody>
      </Card>
      <ConfirmDialog
        open={!!toDelete}
        title={`Delete ${toDelete ?? ''} from ${project.name}?`}
        confirmLabel="Delete"
        danger
        loading={remove.isPending}
        onConfirm={() => toDelete && remove.mutate(toDelete)}
        onCancel={() => setToDelete(null)}
      >
        Work in this project that needs it will fail until you save it again. This cannot be undone.
        {remove.isError && <p className="mt-2 text-red-600">{errorMessage(remove.error)}</p>}
      </ConfirmDialog>
    </div>
  );
}
