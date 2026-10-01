import type { AuthUser } from '@internal/web-kit';
import { useEffect, useState } from 'react';

import { useAuthEnv } from './auth-context.js';

export type AccountState =
  { status: 'unknown' } | { status: 'signed-out' } | { status: 'signed-in'; user: AuthUser };

/** Whether this browser has a session (shared with the admin app via localStorage). */
export function useAccount(): AccountState {
  const { auth } = useAuthEnv();
  const [state, setState] = useState<AccountState>(() =>
    auth.configured ? { status: 'unknown' } : { status: 'signed-out' },
  );

  useEffect(() => {
    if (!auth.configured) return;
    let cancelled = false;
    void (async () => {
      try {
        const user = (await auth.isAuthenticated()) ? await auth.getUser() : null;
        if (!cancelled) setState(user ? { status: 'signed-in', user } : { status: 'signed-out' });
      } catch {
        // A failed check (e.g. the SDK chunk didn't load) just shows "Sign in".
        if (!cancelled) setState({ status: 'signed-out' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [auth]);

  return state;
}
