import { AccountMenu, Logo } from '@internal/ui';
import type { ReactNode } from 'react';
import { Link, Outlet, useLocation } from 'react-router';

import { useAccount } from './account.js';
import { useAuthEnv } from './auth-context.js';
import { SignInDialog } from './SignInDialog.js';

// Opens the modal over the current page; an existing `next` (e.g. from the guard) is kept.
function useSignInLink(): string {
  const { pathname, search, hash } = useLocation();
  const params = new URLSearchParams(search);
  params.set('signin', '1');
  return `${pathname}?${params.toString()}${hash}`;
}

function AccountNav() {
  const { auth, origins } = useAuthEnv();
  const signInLink = useSignInLink();
  const account = useAccount();
  const myTours = `${origins.admin}/app/`;

  if (account.status === 'unknown') return null;
  if (account.status === 'signed-out') {
    return (
      <Link to={signInLink} className="app-shell__link">
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
