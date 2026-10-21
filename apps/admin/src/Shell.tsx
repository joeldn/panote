import { Logo } from '@internal/ui';
import type { ReactNode } from 'react';
import { Link, Outlet } from 'react-router';

import { OwnerAccountMenu } from './account/OwnerAccountMenu.js';
import { useOptionalSession } from './session.js';

/** Top bar + page; shows the account menu once `RequireAuth` has a session. */
export function Shell() {
  const session = useOptionalSession();
  return (
    <div className="app-shell">
      <header className="app-shell__bar">
        <Link to="/" className="app-shell__home">
          <Logo />
        </Link>
        {session && <OwnerAccountMenu session={session} />}
      </header>
      <main className="app-shell__main">
        <Outlet />
      </main>
    </div>
  );
}

export function Placeholder({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <section className="placeholder">
      <h1>{title}</h1>
      {children}
    </section>
  );
}

/** A full-page message (unconfigured auth, a failed callback). */
export function Notice({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="placeholder" role="alert">
      <h1>{title}</h1>
      {children}
    </section>
  );
}
