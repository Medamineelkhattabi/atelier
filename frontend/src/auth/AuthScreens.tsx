// First-run owner setup and login.

import { useState, type FormEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import { KeyRound, LogIn, ShieldCheck } from 'lucide-react';
import { login, setupOwner } from '../api/endpoints';
import type { SessionOpened } from '../api/types';
import { Alert, Button, ErrorState, Field, Input } from '../components/ui';

const USERNAME = /^[A-Za-z0-9_.-]{2,64}$/;

export function AuthScreen({ mode, onSession }: { mode: 'setup' | 'login'; onSession: (s: SessionOpened) => void }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-zinc-50 px-4 py-10 dark:bg-zinc-950">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-md bg-accent-600 text-white">
            <ShieldCheck className="h-4 w-4" aria-hidden />
          </span>
          <div>
            <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Atelier</p>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">Your AI team, your rules</p>
          </div>
        </div>
        <div className="rounded-lg border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
          {mode === 'setup' ? <SetupForm onSession={onSession} /> : <LoginForm onSession={onSession} />}
        </div>
      </div>
    </main>
  );
}

function SetupForm({ onSession }: { onSession: (s: SessionOpened) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [token, setToken] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const mutation = useMutation({ mutationFn: setupOwner, onSuccess: onSession });

  function submit(event: FormEvent) {
    event.preventDefault();
    const next: Record<string, string> = {};
    if (!USERNAME.test(username)) next.username = '2 to 64 characters: letters, digits, _ . -';
    if (password.length < 10) next.password = `Too short: ${password.length} characters, at least 10 needed.`;
    if (confirm !== password) next.confirm = 'The passwords do not match.';
    if (!token.trim()) next.token = 'Copy the setup token from the server log.';
    setErrors(next);
    if (Object.keys(next).length === 0) {
      mutation.mutate({ username, password, setup_token: token.trim() });
    }
  }

  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Create the owner account</h1>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          This platform has a single owner. The one-time setup token is printed in the server log at startup.
        </p>
      </div>
      <Field label="Username" htmlFor="setup-username" error={errors.username} required>
        <Input
          id="setup-username"
          autoComplete="username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          aria-invalid={!!errors.username}
        />
      </Field>
      <Field label="Password" htmlFor="setup-password" error={errors.password} hint="At least 10 characters." required>
        <Input
          id="setup-password"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          aria-invalid={!!errors.password}
        />
      </Field>
      <Field label="Confirm password" htmlFor="setup-confirm" error={errors.confirm} required>
        <Input
          id="setup-confirm"
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          aria-invalid={!!errors.confirm}
        />
      </Field>
      <Field label="Setup token" htmlFor="setup-token" error={errors.token} hint="From the server log." required>
        <Input
          id="setup-token"
          mono
          autoComplete="off"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          aria-invalid={!!errors.token}
        />
      </Field>
      {mutation.isError && <ErrorState compact error={mutation.error} title="Setup failed" />}
      <Button type="submit" variant="primary" size="md" className="w-full" loading={mutation.isPending} icon={<KeyRound className="h-4 w-4" />}>
        Create owner account
      </Button>
    </form>
  );
}

function LoginForm({ onSession }: { onSession: (s: SessionOpened) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const mutation = useMutation({ mutationFn: login, onSuccess: onSession });

  function submit(event: FormEvent) {
    event.preventDefault();
    if (username && password) mutation.mutate({ username, password });
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Sign in</h1>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">Owner account of this platform.</p>
      </div>
      <Field label="Username" htmlFor="login-username" required>
        <Input
          id="login-username"
          autoComplete="username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          required
        />
      </Field>
      <Field label="Password" htmlFor="login-password" required>
        <Input
          id="login-password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
      </Field>
      {mutation.isError && <ErrorState compact error={mutation.error} title="Sign-in failed" />}
      <Button
        type="submit"
        variant="primary"
        size="md"
        className="w-full"
        loading={mutation.isPending}
        disabled={!username || !password}
        icon={<LogIn className="h-4 w-4" />}
      >
        Sign in
      </Button>
      <Alert tone="gray">
        Forgot the password? Run <code className="font-mono text-xs">python -m pae.cli set-password &lt;username&gt;</code> on the server.
      </Alert>
    </form>
  );
}
