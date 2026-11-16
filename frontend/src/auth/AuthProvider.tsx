// Session state: owner setup, login, CSRF token for writes, sign-out.

import { createContext, useCallback, useContext, useEffect, useMemo, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { onUnauthorized, setCsrfToken } from '../api/client';
import { getAuthState, logout as apiLogout } from '../api/endpoints';
import { qk } from '../api/keys';
import type { AuthState, SessionOpened } from '../api/types';
import { ErrorState, LoadingState } from '../components/ui';
import { AuthScreen } from './AuthScreens';

interface AuthContextValue {
  username: string | null;
  /** Called after setup/login: stores the CSRF token and loads the app. */
  sessionOpened: (session: SessionOpened) => void;
  signOut: () => Promise<void>;
  /** After a password change the backend signs out every session. */
  sessionEnded: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside <AuthProvider>');
  return value;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const state = useQuery({ queryKey: qk.auth, queryFn: getAuthState, staleTime: Infinity, retry: 1 });

  useEffect(() => {
    setCsrfToken(state.data?.csrf_token ?? null);
  }, [state.data?.csrf_token]);

  const sessionEnded = useCallback(() => {
    setCsrfToken(null);
    // Drop cached data of the closed session, then re-read the auth state (shows the login screen).
    queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== qk.auth[0] });
    void queryClient.invalidateQueries({ queryKey: qk.auth });
  }, [queryClient]);

  useEffect(() => {
    onUnauthorized(() => {
      setCsrfToken(null);
      void queryClient.invalidateQueries({ queryKey: qk.auth });
    });
    return () => onUnauthorized(null);
  }, [queryClient]);

  const sessionOpened = useCallback(
    (session: SessionOpened) => {
      setCsrfToken(session.csrf_token);
      queryClient.setQueryData<AuthState>(qk.auth, {
        has_owner: true,
        authenticated: true,
        username: session.username,
        csrf_token: session.csrf_token,
      });
    },
    [queryClient],
  );

  const signOut = useCallback(async () => {
    try {
      await apiLogout();
    } finally {
      sessionEnded();
    }
  }, [sessionEnded]);

  const value = useMemo<AuthContextValue>(
    () => ({ username: state.data?.username ?? null, sessionOpened, signOut, sessionEnded }),
    [state.data?.username, sessionOpened, signOut, sessionEnded],
  );

  if (state.isPending) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <LoadingState label="Connecting to the platform…" />
      </div>
    );
  }
  if (state.isError) {
    return (
      <div className="mx-auto flex min-h-screen max-w-lg items-center px-4">
        <div className="w-full">
          <ErrorState error={state.error} title="Cannot reach the backend" onRetry={() => void state.refetch()} />
        </div>
      </div>
    );
  }
  if (!state.data.authenticated) {
    return <AuthScreen mode={state.data.has_owner ? 'login' : 'setup'} onSession={sessionOpened} />;
  }
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
