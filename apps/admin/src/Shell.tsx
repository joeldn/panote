import { Logo } from '@internal/ui';
import type { ReactNode } from 'react';
import { Link, Outlet } from 'react-router';

// The route guard (signed out -> /?signin=1&next=<path>) lands with unit C3.
export function Shell() {
  return (
    <div className="app-shell">
      <header className="app-shell__bar">
        <Link to="/" className="app-shell__home">
          <Logo />
        </Link>
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
