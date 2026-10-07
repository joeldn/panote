import './dashboard.css';

import type { PanoSummary } from './types.js';
import { Button, ConfirmModal } from '@internal/ui';
import { tilesBaseUrl } from '@internal/web-kit';
import { useRef, useState } from 'react';
import { Link } from 'react-router';

import { useConfig } from '../config-context.js';
import { useSession } from '../session.js';
import { coverUrl } from './cover.js';
import { plural, relativeTime } from './format.js';
import { isProcessing, panoTitle, useUnusedPanos } from './use-unused-panos.js';

function Thumb({ src }: { src: string | null }) {
  const [failed, setFailed] = useState<string | null>(null);
  if (src && src !== failed) {
    return (
      <img
        className="unused__thumb"
        src={src}
        alt=""
        loading="lazy"
        decoding="async"
        onError={() => setFailed(src)}
      />
    );
  }
  return (
    <div className="unused__thumb unused__thumb--empty" data-testid="thumb-fallback">
      <i className="fa-solid fa-panorama" aria-hidden="true" />
    </div>
  );
}

function Row({
  pano,
  thumb,
  now,
  onDelete,
}: {
  pano: PanoSummary;
  thumb: string | null;
  now: number;
  onDelete(p: PanoSummary): void;
}) {
  const title = panoTitle(pano);
  const processing = isProcessing(pano);
  return (
    <li className="unused__row">
      <Thumb src={thumb} />
      <div className="unused__text">
        <span className="unused__title">{title}</span>
        <span className="unused__meta">
          {processing ? 'Still processing' : `Updated ${relativeTime(pano.updatedAt, now)}`}
        </span>
      </div>
      <button
        type="button"
        className="dash-card__action dash-card__action--danger"
        title="Delete"
        aria-label={`Delete “${title}”`}
        onClick={() => onDelete(pano)}
      >
        <i className="fa-solid fa-trash-can" aria-hidden="true" />
      </button>
    </li>
  );
}

/** Panos none of the owner's tours use (left behind when a scene is removed), with delete. */
export function UnusedPanos() {
  const { api } = useSession();
  const config = useConfig();
  const unused = useUnusedPanos(api);
  const [now] = useState(() => Date.now());
  const [confirm, setConfirm] = useState<PanoSummary | null>(null);
  const inFlight = useRef<Promise<void> | null>(null);
  const tilesBase = tilesBaseUrl(config);

  const confirmDelete = (): Promise<void> => {
    // Same double-click guard as the tour delete on the dashboard.
    if (inFlight.current) return inFlight.current;
    const pano = confirm;
    if (!pano) return Promise.resolve();
    const run = unused
      .deletePano(pano)
      .then(() => setConfirm(null))
      .finally(() => {
        inFlight.current = null;
      });
    inFlight.current = run;
    return run;
  };

  let body;
  if (unused.status === 'loading') {
    body = (
      <p className="app-status" role="status">
        Loading your panos…
      </p>
    );
  } else if (unused.status === 'error') {
    body = (
      <div className="dash__banner dash__banner--warn" role="alert">
        <span>Couldn’t load your panos.</span>
        <Button size="sm" variant="ghost" onClick={unused.reload}>
          Try again
        </Button>
      </div>
    );
  } else {
    body = (
      <>
        {unused.notice && (
          <div className="dash__banner" role="status">
            <span>{unused.notice}</span>
            <Button size="sm" variant="ghost" onClick={unused.dismissNotice}>
              Dismiss
            </Button>
          </div>
        )}
        {unused.panos.length === 0 ? (
          <p className="unused__empty">Every pano you’ve uploaded is in a tour.</p>
        ) : (
          <>
            <p className="unused__count">{plural(unused.panos.length, 'unused pano')}</p>
            <ul className="unused__list">
              {unused.panos.map((pano) => (
                <Row
                  key={pano.panoId}
                  pano={pano}
                  thumb={coverUrl(tilesBase, pano)}
                  now={now}
                  onDelete={setConfirm}
                />
              ))}
            </ul>
          </>
        )}
      </>
    );
  }

  return (
    <section className="dash">
      <header className="dash__head">
        <div>
          <p className="dash__kicker">
            <Link to="/" className="unused__back">
              <i className="fa-solid fa-arrow-left" aria-hidden="true" /> Your tours
            </Link>
          </p>
          <h1 className="dash__title">Unused panos</h1>
          <p className="unused__intro">
            Panos none of your tours use, such as ones removed from a tour. Deleting one removes its
            image for good.
          </p>
        </div>
      </header>
      {body}
      <ConfirmModal
        open={confirm !== null}
        title="Delete this pano?"
        body={
          confirm
            ? `“${panoTitle(confirm)}” isn’t in any of your tours. Its image will be permanently deleted. This can’t be undone.`
            : ''
        }
        confirmLabel="Delete pano"
        onConfirm={confirmDelete}
        onCancel={() => setConfirm(null)}
      />
    </section>
  );
}
