import './dashboard.css';

import type { TourSummary } from './types.js';
import { MAX_TOURS_PER_OWNER } from '@internal/contracts';
import { Button, ConfirmModal } from '@internal/ui';
import { createPublicApi, tilesBaseUrl } from '@internal/web-kit';
import { useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, Outlet, useSearchParams } from 'react-router';

import { useAuthEnv } from '../auth-context.js';
import { useConfig } from '../config-context.js';
import { useSession } from '../session.js';
import { FileDrop } from '../upload/FileDrop.js';
import { useUploads } from '../upload/upload-context.js';
import { coverImage } from './cover.js';
import { readCurrentTour } from './current-tour.js';
import { formatCount, plural } from './format.js';
import { TourCard } from './TourCard.js';
import { UnusedPanos } from './UnusedPanos.js';
import { useDashboard, type Dashboard as DashboardData } from './use-dashboard.js';

/** What the dashboard lists, from `?view=`: the owner's tours unless it says otherwise. */
type View = 'yours' | 'shared' | 'unused';
const VIEWS: Record<View, string> = {
  yours: 'Your tours',
  shared: 'Shared with you',
  unused: 'Unused panos',
};
const viewOf = (param: string | null): View =>
  param === 'shared' || param === 'unused' ? param : 'yours';

/** "4 tours", or "4 / 200 tours" once the limit is known. */
const counted = (n: number, word: string, max: number | null | undefined): string =>
  typeof max === 'number' ? `${n} / ${max} ${word}s` : plural(n, word);

/**
 * One mono line under the title: "4 / 200 tours · 20 / 500 panos · 18k views". Plain counts
 * until the usage call answers, and for any limit that isn't set.
 */
function Totals({ dash }: { dash: DashboardData }) {
  // Only tours still listed, so a deleted tour's views drop out of the total.
  const known = dash.tours
    .map((t) => dash.views[t.tourId])
    .filter((v): v is number => typeof v === 'number');
  const limits = dash.usage?.limits;
  const parts = [counted(dash.tours.length, 'tour', dash.usage && MAX_TOURS_PER_OWNER)];
  const panos = dash.panos?.size ?? dash.usage?.panos;
  if (panos !== undefined) parts.push(counted(panos, 'pano', limits?.maxPanos));
  if (known.length) {
    const total = known.reduce((a, b) => a + b, 0);
    parts.push(`${formatCount(total)} view${total === 1 ? '' : 's'}`);
  }
  return <p className="dash__totals">{parts.join(' · ')}</p>;
}

/**
 * The filter row: a chip per list with something in it, and none at all when the owner's
 * own tours are all there is. The chip in use stays, so there is always a way back.
 */
function Filters({
  view,
  counts,
  onPick,
}: {
  view: View;
  counts: Record<View, number | null>;
  onPick(v: View): void;
}) {
  const shown = (Object.keys(VIEWS) as View[]).filter(
    (v) => v === 'yours' || v === view || (counts[v] ?? 0) > 0,
  );
  if (shown.length < 2) return null;
  return (
    <div className="dash__filters" role="group" aria-label="Show">
      {shown.map((v) => (
        <button
          key={v}
          type="button"
          className="dash__filter"
          aria-pressed={v === view}
          onClick={() => onPick(v)}
        >
          {VIEWS[v]}
          {counts[v] !== null && (
            <>
              {' '}
              <span className="dash__filter-n">{counts[v]}</span>
            </>
          )}
        </button>
      ))}
    </div>
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

function Retry({
  text,
  onRetry,
  role = 'alert',
}: {
  text: string;
  onRetry(): void;
  role?: string;
}) {
  return (
    <div className={`dash__banner${role === 'alert' ? ' dash__banner--warn' : ''}`} role={role}>
      <span>{text}</span>
      <Button size="sm" variant="ghost" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}

function Empty() {
  const uploads = useUploads();
  return (
    <div className="dash__empty">
      <div className="dash__empty-icon">
        <i className="fa-solid fa-panorama" aria-hidden="true" />
      </div>
      <h2>No tours yet</h2>
      <p>Upload a 360° photo and it becomes your first tour. Add more panos to it later.</p>
      <Button
        variant="primary"
        icon="fa-solid fa-arrow-up-from-bracket"
        onClick={() => uploads.pick({ kind: 'new-tour' })}
      >
        Upload a pano
      </Button>
    </div>
  );
}

const NEW_TOUR = { kind: 'new-tour' } as const;

function deleteBody(tour: TourSummary): string {
  const panos =
    tour.sceneCount > 0
      ? ` Its ${plural(tour.sceneCount, 'pano')} ${tour.sceneCount === 1 ? 'is' : 'are'} deleted too, unless another of your tours uses ${tour.sceneCount === 1 ? 'it' : 'them'}.`
      : '';
  const link = tour.publish ? ' Its share link stops working.' : '';
  return `“${tour.title}” will be permanently deleted.${panos}${link} This can’t be undone.`;
}

/**
 * "Welcome back" only once the list shows this owner has made something: someone with no
 * tours yet is new here (or starting over), and a plain welcome holds while the list loads.
 */
function greeting(dash: Pick<DashboardData, 'status' | 'tours'>, name?: string): string {
  const to = name ? `, ${name}` : '';
  if (dash.status !== 'ready') return `Welcome${to}.`;
  return dash.tours.length === 0 ? `Welcome to panote${to}.` : `Welcome back${to}.`;
}

/**
 * Owner home (design screens 02 and 13): tour cards and totals, with filters for the tours
 * shared with this account and the panos no tour uses.
 */
export function Dashboard() {
  const { api, upload, user } = useSession();
  const env = useAuthEnv();
  const config = useConfig();
  const publicApi = useMemo(
    () => createPublicApi({ baseUrl: env.apiBase, ...(env.fetch && { fetch: env.fetch }) }),
    [env.apiBase, env.fetch],
  );
  const dash = useDashboard(api, publicApi, upload);
  const uploads = useUploads();
  const [search, setSearch] = useSearchParams();
  const view = viewOf(search.get('view'));
  const [now] = useState(() => Date.now());
  const [currentTour] = useState(readCurrentTour);
  const [confirm, setConfirm] = useState<TourSummary | null>(null);
  const inFlight = useRef<Promise<void> | null>(null);
  const tilesBase = tilesBaseUrl(config);
  const viewSearch = view === 'yours' ? '' : `?view=${view}`;

  const pick = (v: View) => setSearch(v === 'yours' ? {} : { view: v }, { replace: true });

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

  const loading = (text: string) => (
    <p className="app-status" role="status">
      {text}
    </p>
  );

  let list: ReactNode;
  if (view === 'shared') {
    const shared = dash.shared.tours;
    if (dash.shared.status === 'loading') list = loading('Loading the tours shared with you…');
    else if (!shared) {
      list = <Retry text="Couldn’t load the tours shared with you." onRetry={dash.reloadShared} />;
    } else if (shared.length === 0) {
      list = <p className="unused__note">No one has shared a tour with you yet.</p>;
    } else {
      list = (
        <div className="dash__grid">
          {shared.map((tour) => (
            <TourCard
              key={tour.tourId}
              tour={tour}
              // The owner's panos aren't listed here, so there's nothing to draw a cover from.
              cover={null}
              views={dash.views[tour.tourId]}
              current={false}
              now={now}
              siteOrigin={config.siteOrigin}
              ownerEmail={tour.ownerEmail}
              search={viewSearch}
            />
          ))}
        </div>
      );
    }
  } else if (view === 'unused') {
    if (dash.unused.status === 'loading') list = loading('Loading your panos…');
    else if (!dash.unused.panos) {
      list = <Retry text="Couldn’t load your panos." onRetry={dash.reloadUnused} />;
    } else {
      list = (
        <UnusedPanos
          panos={dash.unused.panos}
          tilesBase={tilesBase}
          now={now}
          deletePano={dash.deletePano}
        />
      );
    }
  } else if (dash.tours.length === 0) {
    list = <Empty />;
  } else {
    list = (
      <div className="dash__grid">
        {dash.tours.map((tour) => (
          <TourCard
            key={tour.tourId}
            tour={tour}
            cover={
              tour.coverPanoId ? coverImage(tilesBase, dash.panos?.get(tour.coverPanoId)) : null
            }
            views={dash.views[tour.tourId]}
            current={tour.tourId === currentTour}
            now={now}
            siteOrigin={config.siteOrigin}
            search={viewSearch}
            owner={{
              onVisibility: dash.setVisibility,
              onDuplicate: dash.duplicate,
              onDelete: setConfirm,
            }}
          />
        ))}
      </div>
    );
  }

  // The shared list loads on its own, so it shows even when the owner's tours didn't load.
  const ready = dash.status === 'ready';
  let body: ReactNode;
  if (view !== 'shared' && dash.status === 'loading') {
    body = loading(view === 'unused' ? 'Loading your panos…' : 'Loading your tours…');
  } else if (view !== 'shared' && dash.status === 'error') {
    body = <Retry text="Couldn’t load your tours." onRetry={dash.reload} />;
  } else {
    body = (
      <>
        <Filters
          view={view}
          counts={{
            yours: ready ? dash.tours.length : null,
            shared: dash.shared.tours?.length ?? null,
            unused: dash.unused.panos?.length ?? null,
          }}
          onPick={pick}
        />
        {ready && <PendingDeletes dash={dash} />}
        {ready && dash.notice && (
          <div className="dash__banner dash__banner--warn" role="alert">
            <span>{dash.notice}</span>
            <Button size="sm" variant="ghost" onClick={dash.dismissNotice}>
              Dismiss
            </Button>
          </div>
        )}
        {list}
        {view === 'yours' && dash.shared.status === 'error' && (
          <Retry
            text="Couldn’t load the tours shared with you."
            onRetry={dash.reloadShared}
            role="status"
          />
        )}
      </>
    );
  }

  return (
    <section className="dash">
      <header className="dash__head">
        <div className="dash__intro">
          <h1 className="dash__title">{greeting(dash, user.name?.trim())}</h1>
          {dash.status === 'ready' && (dash.tours.length > 0 || !!dash.panos?.size) && (
            <Totals dash={dash} />
          )}
        </div>
        <Button
          variant="primary"
          icon="fa-solid fa-plus"
          onClick={() => uploads.pick({ kind: 'new-tour' })}
        >
          New tour
        </Button>
      </header>
      <FileDrop target={NEW_TOUR} label="Drop 360° photos to start a new tour" />
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
