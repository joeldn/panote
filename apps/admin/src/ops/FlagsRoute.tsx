import type { FlagReason, FlagRecord } from '@internal/contracts';
import { Button, SignInModal } from '@internal/ui';
import { ReauthRequiredError, type ConnectionId } from '@internal/web-kit';
import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';

import { useAuthEnv } from '../auth-context.js';
import { useSession } from '../session.js';

/** Short labels for the queue; the tour page's own read longer (website FlagDialog.tsx). */
const REASON: Record<FlagReason, string> = {
  sexual: 'Sexual',
  'child-safety': 'Child safety',
  violence: 'Violence',
  hate: 'Hate',
  illegal: 'Illegal',
  privacy: 'Privacy',
  copyright: 'Copyright',
  spam: 'Spam',
  other: 'Other',
};

type Load =
  { status: 'loading' | 'error' } | { status: 'ready'; flags: FlagRecord[]; more: boolean };

/** Flags on one panorama of one tour, newest first. */
type Group = { tourId: string; panoId: string; slug: string; flags: FlagRecord[] };

const groupFlags = (flags: FlagRecord[]): Group[] => {
  const groups = new Map<string, Group>();
  for (const f of flags) {
    const key = `${f.tourId}/${f.panoId}`;
    const g = groups.get(key) ?? { tourId: f.tourId, panoId: f.panoId, slug: f.slug, flags: [] };
    g.flags.push(f);
    groups.set(key, g);
  }
  return [...groups.values()];
};

const when = (iso: string): string => iso.slice(0, 16).replace('T', ' ');

/**
 * /app/ops/flags: what visitors reported, grouped by panorama, most recent first. Open the
 * scene, act on its tour from the Users page (hide, unpublish, disable the owner), then
 * Dismiss the flags dealt with.
 */
export function FlagsRoute() {
  const { api } = useSession();
  const { auth, origins } = useAuthEnv();
  const { pathname, search } = useLocation();
  const navigate = useNavigate();
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);

  useEffect(() => {
    let live = true;
    api.listFlags().then(
      (l) => live && setLoad({ status: 'ready', flags: l.flags, more: l.more }),
      () => live && setLoad({ status: 'error' }),
    );
    return () => {
      live = false;
    };
  }, [api, attempt]);

  // The tour's owner on the Users page, found through its owner pointer.
  const findOwner = async (tourId: string) => {
    setNote(null);
    try {
      const found = await api.supportLookup(tourId);
      if (found) void navigate(`/ops/users?sub=${encodeURIComponent(found.sub)}`);
      else setNote('No owner found for that tour. It may have been deleted.');
    } catch {
      setNote('That didn’t work. Try again.');
    }
  };

  const dismiss = async (group: Group) => {
    setBusy(true);
    setNote(null);
    try {
      const l = await api.dismissFlags(group.flags.map((f) => f.flagId));
      setLoad({ status: 'ready', flags: l.flags, more: l.more });
    } catch (e) {
      if (e instanceof ReauthRequiredError) setSigningIn(true);
      else setNote('That didn’t work. Try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="support">
      <p className="support__note">
        Visitors’ reports on a panorama. Open it, act on its tour from Users, then dismiss.
      </p>
      {note && (
        <div className="dash__banner dash__banner--warn" role="alert">
          <span>{note}</span>
        </div>
      )}
      {load.status === 'loading' && (
        <p className="app-status" role="status">
          Loading…
        </p>
      )}
      {load.status === 'error' && (
        <div className="dash__banner dash__banner--warn" role="alert">
          <span>Couldn’t load the flags.</span>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setLoad({ status: 'loading' });
              setAttempt((n) => n + 1);
            }}
          >
            Try again
          </Button>
        </div>
      )}
      {load.status === 'ready' &&
        (load.flags.length === 0 ? (
          <p className="ops__empty">No flags.</p>
        ) : (
          <>
            <ul className="support__list">
              {groupFlags(load.flags).map((g) => {
                const counts = new Map<FlagReason, number>();
                for (const f of g.flags) counts.set(f.reason, (counts.get(f.reason) ?? 0) + 1);
                const notes = g.flags.filter((f) => f.note);
                return (
                  <li key={`${g.tourId}/${g.panoId}`} className="support__row">
                    <span className="support__row-main">
                      <a
                        href={`${origins.website}/s/${encodeURIComponent(g.slug)}?pano=${encodeURIComponent(g.panoId)}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {g.slug} · {g.panoId}
                      </a>
                      <span className="support__meta">
                        {[...counts]
                          .map(([r, n]) => (n > 1 ? `${REASON[r]} ×${n}` : REASON[r]))
                          .join(' · ')}
                        {` · last ${when(g.flags[0]!.at)}`}
                      </span>
                      {notes.map((f) => (
                        <span key={f.flagId} className="support__meta flags__note">
                          “{f.note}”
                        </span>
                      ))}
                    </span>
                    <span className="support__actions">
                      <Button size="sm" variant="ghost" onClick={() => void findOwner(g.tourId)}>
                        Find owner
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => void dismiss(g)}
                      >
                        Dismiss
                      </Button>
                    </span>
                  </li>
                );
              })}
            </ul>
            {load.more && (
              <p className="support__note">
                Showing the newest flags. Dismiss these to see older ones.
              </p>
            )}
          </>
        ))}
      <SignInModal
        open={signingIn}
        onClose={() => setSigningIn(false)}
        title="Sign in again to dismiss"
        subtitle="Dismissing flags needs a recent sign-in. You’ll come back to this page; then dismiss again."
        options={auth.connections}
        onSignIn={(id) =>
          auth.signIn({
            connection: id as ConnectionId,
            returnTo: `/app${pathname}${search}`,
            reauthenticate: true,
          })
        }
        termsHref={`${origins.website}/terms`}
        privacyHref={`${origins.website}/privacy`}
      />
    </div>
  );
}
