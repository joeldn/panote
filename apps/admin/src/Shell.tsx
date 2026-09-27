import { AccountMenu, Logo } from '@internal/ui';
import type { ReactNode } from 'react';
import { Link, Outlet } from 'react-router';

import { useAuthEnv } from './auth-context.js';
import { useOptionalSession, type Session } from './session.js';

function Account({ session }: { session: Session }) {
  const { origins } = useAuthEnv();
  return (
    <AccountMenu
      user={session.user}
      items={[{ label: 'Home page', icon: 'fa-solid fa-house', href: `${origins.website}/` }]}
      onSignOut={session.signOut}
    />
  );
}

/** Top bar + page; shows the account menu once `RequireAuth` has a session. */
export function Shell() {
  const session = useOptionalSession();
  return (
    <div className="app-shell">
      <header className="app-shell__bar">
        <Link to="/" className="app-shell__home">
          <Logo />
        </Link>
        {session && <Account session={session} />}
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
      <p>{children}</p>
    </section>
  );
}
