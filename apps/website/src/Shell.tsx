import { AccountMenu, Logo } from '@internal/ui';
import { signInPath } from '@internal/web-kit';
import type { ReactNode } from 'react';
import { Link, Outlet } from 'react-router';

import { useAccount } from './account.js';
import { useAuthEnv } from './auth-context.js';
import { SignInDialog } from './SignInDialog.js';

function AccountNav() {
  const { auth, origins } = useAuthEnv();
  const account = useAccount();
  const myTours = `${origins.admin}/app/`;

  if (account.status === 'unknown') return null;
  if (account.status === 'signed-out') {
    return (
      <Link to={signInPath()} className="app-shell__link">
        Sign in
      </Link>
    );
  }
  return (
    <div className="app-shell__account">
      <a href={myTours} className="app-shell__link">
        My tours
      </a>
      <AccountMenu
        user={account.user}
        items={[{ label: 'My tours', icon: 'fa-solid fa-layer-group', href: myTours }]}
        onSignOut={() => auth.signOut(`${origins.website}/`)}
      />
    </div>
  );
}

export function Shell() {
  return (
    <div className="app-shell">
      <header className="app-shell__bar">
        <Link to="/" className="app-shell__home">
          <Logo />
        </Link>
        <AccountNav />
      </header>
      <main className="app-shell__main">
        <Outlet />
      </main>
      <SignInDialog />
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
