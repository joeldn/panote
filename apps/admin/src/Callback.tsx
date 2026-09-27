import { returnTarget, signInPath } from '@internal/web-kit';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';

import { useAuthEnv } from './auth-context.js';
import { Notice } from './Shell.js';

/** Auth0's redirect target for both apps: finish the code exchange, then go to returnTo. */
export function Callback() {
  const { auth, origins, assign } = useAuthEnv();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  // The code is single-use: StrictMode's second effect run must not redeem it again.
  const started = useRef(false);

  useEffect(() => {
    if (started.current || !auth.configured) return;
    started.current = true;
    auth
      .handleCallback(window.location.href)
      .then((path) => {
        const target = returnTarget(path, origins);
        if (target.kind === 'admin') void navigate(target.path, { replace: true });
        else assign(target.url);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [auth, origins, assign, navigate]);

  const retry = new URL(signInPath(), origins.website).href;
  if (!auth.configured) {
    return (
      <Notice title="Sign-in isn’t set up here">
        This build has no Auth0 application configured. <a href={`${origins.website}/`}>Home</a>
      </Notice>
    );
  }
  if (error) {
    return (
      <Notice title="Sign-in didn’t complete">
        {error} <a href={retry}>Try again</a>
      </Notice>
    );
  }
  return (
    <p className="app-status" role="status">
      Signing you in…
    </p>
  );
}
