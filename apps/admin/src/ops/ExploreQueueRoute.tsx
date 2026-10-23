import type { ExploreDecision, ExplorePending } from '@internal/contracts';
import { Button, SignInModal } from '@internal/ui';
import {
  ApiError,
  exploreCoverUrl,
  ReauthRequiredError,
  tilesBaseUrl,
  type ConnectionId,
} from '@internal/web-kit';
import { useEffect, useState } from 'react';
import { useLocation } from 'react-router';

import { useAuthEnv } from '../auth-context.js';
import { useConfig } from '../config-context.js';
import { useSession } from '../session.js';

type Load = { status: 'loading' | 'error' } | { status: 'ready'; tours: ExplorePending[] };

const day = (iso: string): string => iso.slice(0, 10);

/**
 * /app/ops/explore: the Public tours waiting for the operator before they are listed on
 * Explore, oldest first. Open one by its link, then approve it (listed) or reject it (hidden
 * from Explore; its link keeps working). A tour that changed since the page loaded is
 * refused, and the queue reloads to show what it is now.
 */
export function ExploreQueueRoute() {
  const { api } = useSession();
  const { auth, origins } = useAuthEnv();
  const config = useConfig();
  const { pathname, search } = useLocation();
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);

  useEffect(() => {
    let live = true;
    api.exploreQueue().then(
      (q) => live && setLoad({ status: 'ready', tours: q.tours }),
      () => live && setLoad({ status: 'error' }),
    );
    return () => {
      live = false;
    };
  }, [api, attempt]);
  const reload = () => {
    setLoad({ status: 'loading' });
    setAttempt((n) => n + 1);
  };

  const decide = async (tour: ExplorePending, action: ExploreDecision) => {
    setBusy(tour.tourId);
    setNote(null);
    try {
      const q = await api.exploreDecide(tour.tourId, action, tour.fingerprint);
      setLoad({ status: 'ready', tours: q.tours });
    } catch (e) {
      if (e instanceof ReauthRequiredError) setSigningIn(true);
      else if (e instanceof ApiError && e.status === 409) {
        setNote(`“${tour.title}” changed since you looked. Check it again before deciding.`);
        reload();
      } else setNote('That didn’t work. Try again.');
    } finally {
      setBusy(null);
    }
  };

  const tilesBase = tilesBaseUrl(config);
  return (
    <div className="support">
      <p className="support__note">
        Public tours are listed on Explore only once you approve them, and again after any change to
        what they show. Rejecting hides a tour from Explore; its link keeps working.
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
          <span>Couldn’t load the queue.</span>
          <Button size="sm" variant="ghost" onClick={reload}>
            Try again
          </Button>
        </div>
      )}
      {load.status === 'ready' &&
        (load.tours.length === 0 ? (
          <p className="ops__empty">Nothing waiting.</p>
        ) : (
          <ul className="support__list">
            {load.tours.map((t) => (
              <li key={t.tourId} className="support__row queue__row">
                {t.cover ? (
                  <img className="queue__cover" src={exploreCoverUrl(tilesBase, t.cover)} alt="" />
                ) : (
                  <span className="queue__cover" />
                )}
                <span className="support__row-main">
                  <a href={`${origins.website}/s/${t.slug}`} target="_blank" rel="noreferrer">
                    {t.title || 'Untitled tour'}
                  </a>
                  <span className="support__meta">
                    {[
                      t.reason === 'changed' ? 'Changed since approved' : 'New',
                      `${t.sceneCount} scene(s)`,
                      `Waiting since ${day(t.queuedAt)}`,
                    ].join(' · ')}
                  </span>
                  <span className="support__id">{t.tourId}</span>
                </span>
                <span className="support__actions">
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={busy !== null}
                    onClick={() => void decide(t, 'approve')}
                  >
                    Approve
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy !== null}
                    onClick={() => void decide(t, 'reject')}
                  >
                    Reject
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        ))}
      <SignInModal
        open={signingIn}
        onClose={() => setSigningIn(false)}
        title="Sign in again to decide"
        subtitle="Approving or rejecting needs a recent sign-in. You’ll come back to this page; then decide again."
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
