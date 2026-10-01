import { SignInModal } from '@internal/ui';
import { signInPath, type AuthUser, type ConnectionId } from '@internal/web-kit';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Outlet, useLocation } from 'react-router';

import { useAuthEnv } from './auth-context.js';
import { runBeforeSignIn } from './before-sign-in.js';
import { sweepDrafts } from './editor/draft.js';
import { createSessionApi, SessionContext, type Session } from './session.js';
import { Notice } from './Shell.js';

type GuardState =
  | { status: 'checking' }
  | { status: 'redirecting' }
  | { status: 'ready'; user: AuthUser }
  | { status: 'error'; message: string };

/** The current admin URL as a full path (`/app/...` + query + hash) for returnTo. */
function useCurrentPath(): string {
  const { pathname, search, hash } = useLocation();
  return `/app${pathname === '/' ? '/' : pathname}${search}${hash}`;
}

// Guards every admin route but the callback: signed out goes to the website's sign-in with
// next = this page, and a session that dies later (API 401, refresh gone) reopens sign-in here.
export function RequireAuth() {
  const env = useAuthEnv();
  const { auth, origins, assign } = env;
  const path = useCurrentPath();
  const pathRef = useRef(path);
  const [state, setState] = useState<GuardState>({ status: 'checking' });
  const [attempt, setAttempt] = useState(0);
  const [expired, setExpired] = useState(false);
  const warnedRef = useRef(false);

  useEffect(() => {
    pathRef.current = path;
  });

  useEffect(() => {
    if (!auth.configured) return;
    let cancelled = false;
    void (async () => {
      try {
        if (!(await auth.isAuthenticated())) {
          if (cancelled) return;
          setState({ status: 'redirecting' });
          assign(new URL(signInPath(pathRef.current), origins.website).href);
          return;
        }
        const user = (await auth.getUser()) ?? {};
        if (!cancelled) setState({ status: 'ready', user });
      } catch (e) {
        if (!cancelled) setState({ status: 'error', message: (e as Error).message });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [auth, origins, assign, attempt]);

  const api = useMemo(
    () =>
      createSessionApi(auth, () => setExpired(true), {
        baseUrl: env.apiBase,
        ...(env.fetch && { fetch: env.fetch }),
      }),
    [auth, env.apiBase, env.fetch],
  );
  const user = state.status === 'ready' ? state.user : null;
  const session = useMemo<Session | null>(
    () =>
      user && {
        user,
        api,
        signOut: () => {
          // Parked editor drafts belong to this user; don't leave them on a shared machine.
          sweepDrafts();
          return auth.signOut(`${origins.website}/`);
        },
      },
    [user, api, auth, origins],
  );

  if (!auth.configured) {
    return (
      <Notice title="Sign-in isn’t set up here">
        <p>
          This build has no Auth0 application configured, so it can’t sign you in.{' '}
          <a href={`${origins.website}/`}>Back to the home page</a>
        </p>
      </Notice>
    );
  }
  if (state.status === 'error') {
    return (
      <Notice title="Couldn’t check your sign-in">
        <p>
          {state.message}{' '}
          <button type="button" onClick={() => setAttempt((n) => n + 1)}>
            Try again
          </button>
        </p>
      </Notice>
    );
  }
  if (!session) {
    return (
      <p className="app-status" role="status">
        Checking your sign-in…
      </p>
    );
  }
  return (
    <SessionContext value={session}>
      <Outlet />
      <SignInModal
        open={expired}
        onClose={() => setExpired(false)}
        title="Your session has ended"
        subtitle="Sign in again to continue."
        options={auth.connections}
        onSignIn={async (id) => {
          // A screen that can't park its unsaved work stops the first attempt with a
          // warning (shown in the modal); a second click signs in anyway.
          const refusal = runBeforeSignIn();
          if (refusal && !warnedRef.current) {
            warnedRef.current = true;
            throw new Error(`${refusal} Choose a sign-in option again to continue anyway.`);
          }
          await auth.signIn({ connection: id as ConnectionId, returnTo: path });
        }}
        termsHref={`${origins.website}/terms`}
        privacyHref={`${origins.website}/privacy`}
      />
    </SessionContext>
  );
}
