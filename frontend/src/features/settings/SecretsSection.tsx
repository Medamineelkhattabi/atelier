// Settings › Passwords & keys: the platform-wide secrets (project-only ones live in each project).

import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Trash2 } from 'lucide-react';
import { deleteSecret, listSecrets, putSecret } from '../../api/endpoints';
import { qk } from '../../api/keys';
import { Alert, Badge, Button, Card, CardBody, CardHeader, ConfirmDialog, EmptyState, ErrorState, Field, Input, LoadingState, Mono, useHelp } from '../../components/ui';
import { formatDateTime } from '../../lib/format';

const SECRET_NAME = /^[A-Z][A-Z0-9_]{1,99}$/;

export function SecretsSection() {
  const queryClient = useQueryClient();
  const secrets = useQuery({ queryKey: qk.secrets, queryFn: () => listSecrets() });
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [toDelete, setToDelete] = useState<string | null>(null);
  const keptHelp = useHelp('How passwords and keys are kept');
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: qk.secrets });
    void queryClient.invalidateQueries({ queryKey: qk.providers });
  };
  const save = useMutation({
    mutationFn: () => putSecret(name, value),
    onSuccess: () => {
      setValue('');
      setName('');
      refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (secret: string) => deleteSecret(secret),
    onSuccess: refresh,
    onSettled: () => setToDelete(null),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!SECRET_NAME.test(name)) {
      setError('Use capital letters, digits and _ only, starting with a letter, e.g. GITHUB_TOKEN.');
      return;
    }
    if (!value) {
      setError('Paste the password or key itself.');
      return;
    }
    setError(null);
    save.mutate();
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-1.5 text-sm text-zinc-600 dark:text-zinc-400">
        <KeyRound className="h-4 w-4 shrink-0" aria-hidden />
        <p>Stored encrypted on this computer; a value is never shown again.</p>
        {keptHelp.button}
      </div>
      {keptHelp.panel(
        <p>
          Your team uses them to contact a service for you (a GitHub token, an email password). Those saved here work in every project; to keep one
          for a single project, add it on that project’s page in{' '}
          <Link to="/projects" className="font-medium underline">
            My Projects
          </Link>
          .
        </p>,
      )}
      {remove.isError && <ErrorState compact error={remove.error} title="Not deleted. Try again." />}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <Card>
          <CardHeader title="Saved for every project" />
          {secrets.isPending ? (
            <LoadingState />
          ) : secrets.isError ? (
            <div className="p-4">
              <ErrorState error={secrets.error} title="Your passwords and keys could not be listed. Try again." onRetry={() => void secrets.refetch()} />
            </div>
          ) : secrets.data.items.length === 0 ? (
            <EmptyState icon={<KeyRound className="h-5 w-5" aria-hidden />} title="Nothing saved yet" description="Add one when a team member needs it to use a service." />
          ) : (
            <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {secrets.data.items.map((secret) => (
                <li key={secret.name} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3">
                  <div className="min-w-0 flex-1 basis-48">
                    <p className="break-all">
                      <Mono className="font-semibold text-zinc-900 dark:text-zinc-100">{secret.name}</Mono>
                    </p>
                    <p className="text-xs text-zinc-600 dark:text-zinc-400">
                      Ends with <Mono>{secret.hint}</Mono>
                      {secret.updated_at && <> · saved {formatDateTime(secret.updated_at)}</>}
                    </p>
                  </div>
                  {secret.source === 'environment' ? (
                    <Badge tone="blue" title="Set in this computer’s environment; change it there.">
                      From this computer’s settings
                    </Badge>
                  ) : (
                    <Button size="xs" variant="ghost" icon={<Trash2 className="h-3.5 w-3.5" />} onClick={() => setToDelete(secret.name)} aria-label={`Delete ${secret.name}`}>
                      Delete
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card>
          <CardHeader title="Add or replace" description="Saving a name that already exists replaces its value." />
          <CardBody>
            <form onSubmit={submit} className="space-y-3" autoComplete="off">
              <Field label="Name" htmlFor="secret-name" hint="The name a tool asks for: capitals, digits, _.">
                <Input id="secret-name" mono value={name} onChange={(e) => setName(e.target.value.toUpperCase())} placeholder="GITHUB_TOKEN" />
              </Field>
              <Field label="Password or key" htmlFor="secret-value">
                <Input id="secret-value" type="password" autoComplete="new-password" value={value} onChange={(e) => setValue(e.target.value)} />
              </Field>
              {error && (
                <p className="text-xs text-red-700 dark:text-red-400" role="alert">
                  {error}
                </p>
              )}
              {save.isError && <ErrorState compact error={save.error} title="Not saved. Check the name and try again." />}
              {save.isSuccess && (
                <Alert tone="green">
                  Saved {save.data.name} (ends with {save.data.hint}).
                </Alert>
              )}
              <Button type="submit" variant="primary" icon={<KeyRound className="h-4 w-4" />} loading={save.isPending}>
                Save
              </Button>
            </form>
          </CardBody>
        </Card>
      </div>
      <ConfirmDialog
        open={!!toDelete}
        title={`Delete ${toDelete ?? ''}?`}
        confirmLabel="Delete"
        danger
        loading={remove.isPending}
        onConfirm={() => toDelete && remove.mutate(toDelete)}
        onCancel={() => setToDelete(null)}
      >
        Anything that uses it stops working until you save it again. The value cannot be recovered.
      </ConfirmDialog>
    </div>
  );
}
