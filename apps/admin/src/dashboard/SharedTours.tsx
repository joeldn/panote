import type { SharedTourSummary } from '@internal/contracts';
import type { AdminApi } from '@internal/web-kit';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';

import { relativeTime } from './format.js';

type State =
  { status: 'loading' } | { status: 'error' } | { status: 'ready'; tours: SharedTourSummary[] };

/**
 * "Shared with you": tours other people invited the signed-in user to edit. Nothing shows
 * until there is one, so the dashboard looks as before for everyone else.
 */
export function SharedTours({ api, now }: { api: Pick<AdminApi, 'listSharedTours'>; now: number }) {
  const [state, setState] = useState<State>({ status: 'loading' });

  useEffect(() => {
    let live = true;
    api.listSharedTours().then(
      (res) => live && setState({ status: 'ready', tours: res.tours }),
      () => live && setState({ status: 'error' }),
    );
    return () => {
      live = false;
    };
  }, [api]);

  if (state.status === 'loading') return null;
  if (state.status === 'error') {
    return (
      <p className="dash__shared-error" role="status">
        Couldn’t load the tours shared with you. Reload to try again.
      </p>
    );
  }
  if (state.tours.length === 0) return null;
  return (
    <section className="dash__shared" aria-labelledby="dash-shared">
      <h2 id="dash-shared" className="dash__kicker">
        Shared with you
      </h2>
      <ul className="dash__shared-list">
        {state.tours.map((t) => (
          <li key={t.tourId}>
            <Link className="dash__shared-row" to={`/t/${t.tourId}`}>
              <span className="dash__shared-title">{t.title || 'Untitled tour'}</span>
              <span className="dash__shared-meta">
                {t.ownerEmail ? `${t.ownerEmail} · ` : ''}edited {relativeTime(t.updatedAt, now)}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
