import { AccountMenu, cx, Logo } from '@internal/ui';
import { sweepEditorDrafts } from '@internal/web-kit';
import { useEffect, useState, type ReactNode } from 'react';
import { Link, Outlet, useLocation } from 'react-router';

import { useAccount } from './account.js';
import { useAuthEnv } from './auth-context.js';
import { NAV_SECTIONS } from './landing/content.js';
import { SignInDialog } from './SignInDialog.js';
import { SiteFooter } from './SiteFooter.js';
import { UploadLink } from './UploadLink.js';

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
        onSignOut={() => {
          // Same origin as the admin app: drop its parked editor drafts too.
          sweepEditorDrafts();
          return auth.signOut(`${origins.website}/`);
        }}
      />
    </div>
  );
}

// The landing's bar floats over the hero pano and frosts once the page scrolls.
function useScrolled(active: boolean): boolean {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    if (!active) return;
    const update = () => setScrolled(window.scrollY > 8);
    update();
    window.addEventListener('scroll', update, { passive: true });
    return () => window.removeEventListener('scroll', update);
  }, [active]);
  return active && scrolled;
}

// A new page starts at the top (or its #section); query-only changes like ?signin=1 don't scroll.
function useScrollOnNavigate(pathname: string, hash: string) {
  useEffect(() => {
    const target = hash ? document.getElementById(decodeURIComponent(hash.slice(1))) : null;
    if (target) target.scrollIntoView();
    else window.scrollTo(0, 0);
  }, [pathname, hash]);
}

export function Shell() {
  const { pathname, hash } = useLocation();
  const landing = pathname === '/';
  const scrolled = useScrolled(landing);
  useScrollOnNavigate(pathname, hash);
  return (
    <div className="app-shell">
      <header
        className={cx(
          'app-shell__bar',
          landing && 'app-shell__bar--overlay',
          scrolled && 'app-shell__bar--scrolled',
        )}
      >
        <Link to="/" className="app-shell__home">
          <Logo />
        </Link>
        {landing && (
          <nav className="app-shell__sections" aria-label="Sections">
            {NAV_SECTIONS.map((s) => (
              <a key={s.id} href={`#${s.id}`} className="app-shell__link">
                {s.label}
              </a>
            ))}
          </nav>
        )}
        <div className="app-shell__actions">
          <AccountNav />
          <UploadLink className="app-shell__cta">Upload a pano</UploadLink>
        </div>
      </header>
      <main className="app-shell__main">
        <Outlet />
      </main>
      <SiteFooter />
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
