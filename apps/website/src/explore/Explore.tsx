import type { ExplorePage, ExploreTour } from '@internal/contracts';
import { Button } from '@internal/ui';
import { createPublicApi, exploreCoverUrl, tilesBaseUrl, type PublicApi } from '@internal/web-kit';
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';

import { ConfigContext } from '../config-context.js';
import { UploadLink } from '../UploadLink.js';

import './explore.css';

// Same title the website Worker writes into the HTML for /explore (worker/explore.ts).
export const EXPLORE_TITLE = 'Explore 360° tours · panote';

type State =
  | { status: 'loading' }
  | { status: 'error' }
  | {
      status: 'ready';
      tours: ExploreTour[];
      cursor: string | null;
      more: 'idle' | 'loading' | 'error';
    };

// public-api stops after a few list calls when it drops many stale entries, so a page can be
// empty but still have a cursor. Follow it this many more times before showing Load more.
export const MAX_EMPTY_PAGE_HOPS = 3;

/** One page, skipping past empty pages that still have a cursor (at most MAX_EMPTY_PAGE_HOPS). */
async function fetchPage(
  api: PublicApi,
  cursor: string | null,
  signal: AbortSignal,
): Promise<ExplorePage> {
  let page = await api.explore(cursor, { signal });
  for (let hop = 0; hop < MAX_EMPTY_PAGE_HOPS && page.tours.length === 0 && page.cursor; hop++) {
    page = await api.explore(page.cursor, { signal });
  }
  return page;
}

const sceneCount = (n: number) => (n === 1 ? '1 scene' : `${n} scenes`);

function Card({ tour, tilesBase }: { tour: ExploreTour; tilesBase: string | null }) {
  const [broken, setBroken] = useState(false);
  const src = tour.cover && tilesBase ? exploreCoverUrl(tilesBase, tour.cover) : null;
  return (
    <li className="explore-card">
      <Link to={`/s/${tour.slug}`} className="explore-card__link">
        <div className="explore-card__cover">
          {src && !broken ? (
            <img src={src} alt="" loading="lazy" decoding="async" onError={() => setBroken(true)} />
          ) : (
            <i className="fa-solid fa-panorama" aria-hidden="true" />
          )}
        </div>
        <h2 className="explore-card__title">{tour.title || 'Untitled tour'}</h2>
        <p className="explore-card__meta">{sceneCount(tour.sceneCount)}</p>
      </Link>
    </li>
  );
}

const SKELETONS = Array.from({ length: 6 }, (_, i) => i);

/** /explore: every Public tour, newest first, a page at a time. */
export function Explore() {
  const config = useContext(ConfigContext);
  const api = useMemo(
    () => (config ? createPublicApi({ baseUrl: config.apiBase }) : null),
    [config],
  );
  const tilesBase = config ? tilesBaseUrl(config) : null;
  // With no config (a build without one) there is nothing to ask: straight to the error.
  const [state, setState] = useState<State>({ status: api ? 'loading' : 'error' });
  const [attempt, setAttempt] = useState(0);
  const pending = useRef<AbortController | null>(null);

  useEffect(() => {
    const previous = document.title;
    document.title = EXPLORE_TITLE;
    return () => {
      document.title = previous;
    };
  }, []);

  useEffect(() => {
    if (!api) return;
    const ac = new AbortController();
    fetchPage(api, null, ac.signal).then(
      (page) => {
        if (!ac.signal.aborted) setState({ status: 'ready', ...page, more: 'idle' });
      },
      (err: unknown) => {
        if (ac.signal.aborted) return;
        console.warn('explore failed to load', err);
        setState({ status: 'error' });
      },
    );
    return () => {
      ac.abort();
      pending.current?.abort();
    };
  }, [api, attempt]);

  const loadMore = useCallback(() => {
    if (!api || state.status !== 'ready' || !state.cursor || state.more === 'loading') return;
    const ac = new AbortController();
    pending.current = ac;
    const { cursor } = state;
    setState({ ...state, more: 'loading' });
    fetchPage(api, cursor, ac.signal).then(
      (page) => {
        if (ac.signal.aborted) return;
        setState((s) => {
          if (s.status !== 'ready') return s;
          // A tour can move between pages while they load; show it once.
          const seen = new Set(s.tours.map((t) => t.tourId));
          const fresh = page.tours.filter((t) => !seen.has(t.tourId));
          return {
            status: 'ready',
            tours: [...s.tours, ...fresh],
            cursor: page.cursor,
            more: 'idle',
          };
        });
      },
      (err: unknown) => {
        if (ac.signal.aborted) return;
        console.warn('explore failed to load more', err);
        setState((s) => (s.status === 'ready' ? { ...s, more: 'error' } : s));
      },
    );
  }, [api, state]);

  return (
    <section className="explore">
      <header className="explore__head">
        <h1 className="explore__title">Explore</h1>
        <p className="explore__sub">
          Public tours from people on panote, newest first. Click one to walk through it.
        </p>
      </header>

      {state.status === 'loading' && (
        <>
          <p className="explore__status" role="status">
            Loading tours…
          </p>
          <ul className="explore__grid" aria-hidden="true">
            {SKELETONS.map((i) => (
              <li key={i} className="explore-card explore-card--skeleton">
                <div className="explore-card__cover" />
                <div className="explore-card__bar" />
                <div className="explore-card__bar explore-card__bar--short" />
              </li>
            ))}
          </ul>
        </>
      )}

      {state.status === 'error' && (
        <div className="explore__empty" role="alert">
          <i className="fa-solid fa-triangle-exclamation" aria-hidden="true" />
          <h2>Couldn’t load tours</h2>
          <p>Something went wrong on our side. Try again in a moment.</p>
          {api && (
            <Button
              variant="primary"
              pill
              onClick={() => {
                setState({ status: 'loading' });
                setAttempt((n) => n + 1);
              }}
            >
              Try again
            </Button>
          )}
        </div>
      )}

      {state.status === 'ready' && state.tours.length === 0 && !state.cursor && (
        <div className="explore__empty">
          <i className="fa-solid fa-compass" aria-hidden="true" />
          <h2>No public tours yet</h2>
          <p>Tours their owners set to Public show up here. Yours could be the first.</p>
          <UploadLink className="explore__cta">Upload a photo</UploadLink>
        </div>
      )}

      {state.status === 'ready' && (state.tours.length > 0 || state.cursor) && (
        <>
          <ul className="explore__grid">
            {state.tours.map((t) => (
              <Card key={t.tourId} tour={t} tilesBase={tilesBase} />
            ))}
          </ul>
          {state.more === 'error' && (
            <p className="explore__more-error" role="alert">
              Couldn’t load more tours.
            </p>
          )}
          {state.cursor && (
            <div className="explore__more">
              <Button variant="ghost" pill busy={state.more === 'loading'} onClick={loadMore}>
                {state.more === 'error' ? 'Try again' : 'Load more'}
              </Button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
