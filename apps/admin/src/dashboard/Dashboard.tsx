import './dashboard.css';

import type { TourSummary } from './types.js';
import { Button, ConfirmModal } from '@internal/ui';
import { createPublicApi, tilesBaseUrl } from '@internal/web-kit';
import { useMemo, useRef, useState } from 'react';
import { Link, Outlet } from 'react-router';

import { useAuthEnv } from '../auth-context.js';
import { useConfig } from '../config-context.js';
import { useSession } from '../session.js';
import { coverUrl } from './cover.js';
import { readCurrentTour } from './current-tour.js';
import { formatCount, plural } from './format.js';
import { TourCard } from './TourCard.js';
import { useDashboard, type Dashboard as DashboardData } from './use-dashboard.js';

function Totals({ dash }: { dash: DashboardData }) {
  // Only tours still listed, so a deleted tour's views drop out of the total.
  const known = dash.tours
    .map((t) => dash.views[t.tourId])
    .filter((v): v is number => typeof v === 'number');
  const items = [
    [String(dash.tours.length), 'tours'],
    [dash.panos ? String(dash.panos.size) : '–', 'panos'],
    [known.length ? formatCount(known.reduce((a, b) => a + b, 0)) : '–', 'total views'],
  ] as const;
  return (
    <dl className="dash__totals">
      {items.map(([value, label]) => (
        <div key={label} className="dash__total">
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function PendingDeletes({ dash }: { dash: DashboardData }) {
  if (dash.resuming.length) {
    return (
      <p className="dash__banner" role="status">
        <i className="fa-solid fa-spinner fa-spin" aria-hidden="true" /> Finishing an interrupted
        delete ({plural(dash.resuming.length, 'pano')})…
      </p>
    );
  }
  if (!dash.stuck.length) return null;
  return (
    <div className="dash__banner dash__banner--warn" role="alert">
      <span>
        {plural(dash.stuck.length, 'pano')} didn’t finish deleting. They stay hidden until the
        delete completes.
      </span>
      <Button size="sm" variant="ghost" onClick={() => void dash.finishDeleting()}>
        Finish deleting
      </Button>
    </div>
  );
}

function Empty() {
  return (
    <div className="dash__empty">
      <div className="dash__empty-icon">
        <i className="fa-solid fa-panorama" aria-hidden="true" />
      </div>
      <h2>No tours yet</h2>
      <p>Upload a 360° photo and it becomes your first tour. Add more panos to it later.</p>
      <Link to="/new" className="pn-btn pn-btn--primary">
        <i className="fa-solid fa-arrow-up-from-bracket" aria-hidden="true" />
        Upload a pano
      </Link>
    </div>
  );
}

function deleteBody(tour: TourSummary): string {
  const panos =
    tour.sceneCount > 0
      ? ` Its ${plural(tour.sceneCount, 'pano')} ${tour.sceneCount === 1 ? 'is' : 'are'} deleted too, unless another of your tours uses ${tour.sceneCount === 1 ? 'it' : 'them'}.`
      : '';
  const link = tour.publish ? ' Its share link stops working.' : '';
  return `“${tour.title}” will be permanently deleted.${panos}${link} This can’t be undone.`;
}

/** Owner home (design screens 02 and 13): tour cards, totals, duplicate and delete. */
export function Dashboard() {
  const { api, user } = useSession();
  const env = useAuthEnv();
  const config = useConfig();
  const publicApi = useMemo(
    () => createPublicApi({ baseUrl: env.apiBase, ...(env.fetch && { fetch: env.fetch }) }),
    [env.apiBase, env.fetch],
  );
  const dash = useDashboard(api, publicApi);
  const [now] = useState(() => Date.now());
  const [currentTour] = useState(readCurrentTour);
  const [confirm, setConfirm] = useState<TourSummary | null>(null);
  const inFlight = useRef<Promise<void> | null>(null);
  const tilesBase = tilesBaseUrl(config);

  const confirmDelete = (): Promise<void> => {
    // ConfirmModal only disables itself after a re-render; this blocks a fast double click.
    if (inFlight.current) return inFlight.current;
    const tour = confirm;
    if (!tour) return Promise.resolve();
    const run = dash
      .deleteTour(tour)
      .then(() => setConfirm(null))
      .finally(() => {
        inFlight.current = null;
      });
    inFlight.current = run;
    return run;
  };

  const name = user.name?.trim();
  let body;
  if (dash.status === 'loading') {
    body = (
      <p className="app-status" role="status">
        Loading your tours…
      </p>
    );
  } else if (dash.status === 'error') {
    body = (
      <div className="dash__banner dash__banner--warn" role="alert">
        <span>Couldn’t load your tours.</span>
        <Button size="sm" variant="ghost" onClick={dash.reload}>
          Try again
        </Button>
      </div>
    );
  } else {
    body = (
      <>
        <Totals dash={dash} />
        <PendingDeletes dash={dash} />
        {dash.notice && (
          <div className="dash__banner dash__banner--warn" role="alert">
            <span>{dash.notice}</span>
            <Button size="sm" variant="ghost" onClick={dash.dismissNotice}>
              Dismiss
            </Button>
          </div>
        )}
        {dash.tours.length === 0 ? (
          <Empty />
        ) : (
          <div className="dash__grid">
            {dash.tours.map((tour) => (
              <TourCard
                key={tour.tourId}
                tour={tour}
                coverSrc={
                  tour.coverPanoId ? coverUrl(tilesBase, dash.panos?.get(tour.coverPanoId)) : null
                }
                views={dash.views[tour.tourId]}
                current={tour.tourId === currentTour}
                now={now}
                onVisibility={dash.setVisibility}
                onDuplicate={dash.duplicate}
                onDelete={setConfirm}
              />
            ))}
          </div>
        )}
      </>
    );
  }

  return (
    <section className="dash">
      <header className="dash__head">
        <div>
          <p className="dash__kicker">Your tours</p>
          <h1 className="dash__title">{name ? `Welcome back, ${name}.` : 'Welcome back.'}</h1>
        </div>
        <Link to="/new" className="pn-btn pn-btn--primary pn-btn--lg">
          <i className="fa-solid fa-plus" aria-hidden="true" />
          New tour
        </Link>
      </header>
      {body}
      <ConfirmModal
        open={confirm !== null}
        title="Delete this tour?"
        body={confirm ? deleteBody(confirm) : ''}
        confirmLabel="Delete tour"
        onConfirm={confirmDelete}
        onCancel={() => setConfirm(null)}
      />
      <Outlet />
    </section>
  );
}
