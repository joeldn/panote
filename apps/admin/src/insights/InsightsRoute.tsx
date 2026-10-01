import './insights.css';

import { DEFAULT_INSIGHTS_DAYS, type InsightsOk } from '@internal/contracts';
import { Button, Modal, ModalHeader, useModalTitleId } from '@internal/ui';
import { createPublicApi, isAuthError } from '@internal/web-kit';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';

import { useAdminApi } from '../admin-api.js';
import { useAuthEnv } from '../auth-context.js';
import { formatCount, plural } from '../dashboard/format.js';
import { formatDay, formatDuration } from './format.js';

interface TourNames {
  title: string;
  panos: Map<string, string>;
  /** Keyed `<panoId>/<hotspotId>`. */
  points: Map<string, string>;
}

type TourState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; names: TourNames };
type InsightsState =
  | { status: 'loading' }
  | { status: 'ok'; data: InsightsOk }
  | { status: 'unavailable' }
  | { status: 'error' };
// Views come from the exact TourStats counter, not the sampled series.
type ViewsState = { status: 'loading' } | { status: 'ok'; views: number } | { status: 'error' };

const DAYS = DEFAULT_INSIGHTS_DAYS;

/** Insights modal over the editor at /app/t/:tourId/insights (screen 09). */
export function InsightsRoute() {
  const { tourId = '' } = useParams();
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const api = useAdminApi();
  const env = useAuthEnv();
  const publicApi = useMemo(
    () => createPublicApi({ baseUrl: env.apiBase, ...(env.fetch && { fetch: env.fetch }) }),
    [env.apiBase, env.fetch],
  );
  const titleId = useModalTitleId();
  const [tour, setTour] = useState<TourState>({ status: 'loading' });
  const [insights, setInsights] = useState<InsightsState>({ status: 'loading' });
  const [views, setViews] = useState<ViewsState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    api.getTourWithConfigs(tourId).then(
      (res) => {
        if (!live) return;
        if (res.status !== 'ok') {
          setTour({ status: 'error', message: 'This tour no longer exists.' });
          return;
        }
        const { tour: doc, configs } = res.data;
        const panos = new Map<string, string>();
        const points = new Map<string, string>();
        doc.scenes.forEach((s, i) => {
          const entry = configs[s.panoId];
          const config = entry && 'config' in entry ? entry.config : null;
          panos.set(s.panoId, config?.title ?? `Pano ${i + 1}`);
          for (const h of config?.hotspots ?? []) points.set(`${s.panoId}/${h.id}`, h.title);
        });
        setTour({ status: 'ready', names: { title: doc.title, panos, points } });
      },
      (e: unknown) => {
        if (!live) return;
        const message = isAuthError(e)
          ? 'Sign in again to see insights.'
          : 'Couldn’t load this tour. Try again.';
        setTour({ status: 'error', message });
      },
    );
    return () => {
      live = false;
    };
  }, [api, tourId]);

  useEffect(() => {
    let live = true;
    api.getInsights(tourId, DAYS).then(
      (res) => {
        if (!live) return;
        if (res.status === 'not-found') {
          setTour({ status: 'error', message: 'This tour no longer exists.' });
        } else setInsights(res);
      },
      () => live && setInsights({ status: 'error' }),
    );
    publicApi.getStats(tourId).then(
      (s) => live && setViews({ status: 'ok', views: s.views }),
      () => live && setViews({ status: 'error' }),
    );
    return () => {
      live = false;
    };
  }, [api, publicApi, tourId, attempt]);

  const query = search.toString();
  const close = () => void navigate({ pathname: `/t/${tourId}`, search: query ? `?${query}` : '' });
  const retry = () => {
    setInsights({ status: 'loading' });
    setViews({ status: 'loading' });
    setAttempt((n) => n + 1);
  };
  const names = tour.status === 'ready' ? tour.names : null;
  const subtitle = names ? `${names.title} · last ${DAYS} days` : `last ${DAYS} days`;

  let body;
  if (tour.status === 'error') {
    body = (
      <p className="ins__status" role="alert">
        {tour.message}
      </p>
    );
  } else if (!names || insights.status === 'loading') {
    body = (
      <p className="ins__status" role="status">
        Loading insights…
      </p>
    );
  } else {
    const data = insights.status === 'ok' ? insights.data : null;
    body = (
      <>
        <div className="ins__cards">
          <StatCard
            label="Total views"
            value={
              views.status === 'ok'
                ? formatCount(views.views)
                : views.status === 'error'
                  ? 'Unavailable'
                  : '…'
            }
            caption="All time"
          />
          <StatCard
            label="Avg. time"
            value={
              !data
                ? 'Unavailable'
                : data.avgDwellMs === null
                  ? '—'
                  : formatDuration(data.avgDwellMs)
            }
            caption="Per viewing session"
          />
        </div>
        {data ? (
          <>
            <p className="ins__note">
              <i className="fa-solid fa-circle-info" aria-hidden="true" /> Approximate — based on
              sampled data. Total views is an exact count.
            </p>
            <DailyChart daily={data.daily} />
            <ByPano byPano={data.byPano} names={names} />
            <TopPoints top={data.topHotspots} names={names} />
          </>
        ) : (
          <div className="ins__unavailable" role="alert">
            <p className="ins__unavailable-title">
              {insights.status === 'unavailable'
                ? 'Insights unavailable'
                : 'Couldn’t load insights'}
            </p>
            <p className="ins__unavailable-body">
              The analytics service didn’t answer. Your tour and its views are unaffected.
            </p>
            <Button size="sm" icon="fa-solid fa-rotate-right" onClick={retry}>
              Retry
            </Button>
          </div>
        )}
      </>
    );
  }

  return (
    <Modal open onClose={close} width={560} labelledBy={titleId}>
      <ModalHeader id={titleId} title="Insights" subtitle={subtitle} onClose={close} />
      <div className="ins">{body}</div>
    </Modal>
  );
}

function StatCard({ label, value, caption }: { label: string; value: string; caption: string }) {
  return (
    <div className="ins__card">
      <p className="ins__label">{label}</p>
      <p className="ins__value">{value}</p>
      <p className="ins__caption">{caption}</p>
    </div>
  );
}

function DailyChart({ daily }: { daily: InsightsOk['daily'] }) {
  const max = Math.max(0, ...daily.map((d) => d.views));
  const first = daily[0];
  const last = daily[daily.length - 1];
  return (
    <section className="ins__section" aria-labelledby="ins-daily">
      <h3 id="ins-daily" className="ins__label">
        Views over time
      </h3>
      <ol className="ins__chart" aria-label="Views per day">
        {daily.map((d, i) => (
          <li
            key={d.date}
            className={i === daily.length - 1 ? 'ins__bar ins__bar--today' : 'ins__bar'}
            style={{ height: max > 0 ? `${(d.views / max) * 100}%` : undefined }}
            data-empty={d.views === 0 || undefined}
            title={`${formatDay(d.date)}: ${plural(d.views, 'view')}`}
          >
            <span className="ins__sr">{`${formatDay(d.date)}: ${plural(d.views, 'view')}`}</span>
          </li>
        ))}
      </ol>
      {first && last && (
        <div className="ins__axis" aria-hidden="true">
          <span>{formatDay(first.date)}</span>
          <span>{formatDay(last.date)}</span>
        </div>
      )}
      {max === 0 && <p className="ins__empty">No views in the last {daily.length} days.</p>}
    </section>
  );
}

function ByPano({ byPano, names }: { byPano: InsightsOk['byPano']; names: TourNames }) {
  const total = byPano.reduce((sum, p) => sum + p.views, 0);
  return (
    <section className="ins__section" aria-labelledby="ins-pano">
      <h3 id="ins-pano" className="ins__label">
        By pano
      </h3>
      {byPano.length === 0 ? (
        <p className="ins__empty">No pano views yet.</p>
      ) : (
        <ul className="ins__panos">
          {byPano.map((p) => (
            <li key={p.panoId}>
              <div className="ins__pano-row">
                <span>{names.panos.get(p.panoId) ?? 'Removed pano'}</span>
                <span className="ins__meta">{`${formatCount(p.views)} ${p.views === 1 ? 'view' : 'views'}`}</span>
              </div>
              <div className="ins__track">
                <div
                  className="ins__fill"
                  style={{ width: `${total > 0 ? (p.views / total) * 100 : 0}%` }}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function TopPoints({ top, names }: { top: InsightsOk['topHotspots']; names: TourNames }) {
  return (
    <section className="ins__section" aria-labelledby="ins-points">
      <h3 id="ins-points" className="ins__label">
        Most-opened points
      </h3>
      {top.length === 0 ? (
        <p className="ins__empty">No points opened yet.</p>
      ) : (
        <ol className="ins__points">
          {top.map((h, i) => (
            <li key={`${h.panoId}/${h.hotspotId}`} className="ins__point">
              <span className="ins__rank">{i + 1}</span>
              <span className="ins__point-name">
                {names.points.get(`${h.panoId}/${h.hotspotId}`) ?? 'Removed point'}
                <span className="ins__meta">{names.panos.get(h.panoId) ?? 'Removed pano'}</span>
              </span>
              <span className="ins__meta">{plural(h.opens, 'open')}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
