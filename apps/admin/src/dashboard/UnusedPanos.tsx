import type { PanoSummary } from './types.js';
import { ConfirmModal } from '@internal/ui';
import { useRef, useState } from 'react';
import { Navigate } from 'react-router';

import { coverImage, coverStyle, type Cover } from './cover.js';
import { relativeTime } from './format.js';
import { isProcessing, panoTitle } from './use-unused-panos.js';

function Thumb({ cover }: { cover: Cover | null }) {
  const [failed, setFailed] = useState<string | null>(null);
  if (cover && cover.src !== failed) {
    return (
      <img
        className="unused__thumb"
        src={cover.src}
        style={coverStyle(cover)}
        alt=""
        loading="lazy"
        decoding="async"
        onError={() => setFailed(cover.src)}
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
  thumb: Cover | null;
  now: number;
  onDelete(p: PanoSummary): void;
}) {
  const title = panoTitle(pano);
  const processing = isProcessing(pano);
  return (
    <li className="unused__row">
      <Thumb cover={thumb} />
      <div className="unused__text">
        <span className="unused__title">{title}</span>
        <span className="unused__meta">
          {processing ? 'Still processing' : `Updated ${relativeTime(pano.updatedAt, now)}`}
        </span>
      </div>
      <button
        type="button"
        className="unused__delete"
        aria-label={`Delete “${title}”`}
        onClick={() => onDelete(pano)}
      >
        <i className="fa-solid fa-trash-can" aria-hidden="true" />
        Delete
      </button>
    </li>
  );
}

export interface UnusedPanosProps {
  /** Already filtered to the unused ones, newest first. */
  panos: PanoSummary[];
  tilesBase: string;
  now: number;
  deletePano(pano: PanoSummary): Promise<void>;
}

/**
 * The dashboard's "Unused panos" filter: panos none of the owner's tours use (left behind
 * when a scene is removed), with delete.
 */
export function UnusedPanos({ panos, tilesBase, now, deletePano }: UnusedPanosProps) {
  const [confirm, setConfirm] = useState<PanoSummary | null>(null);
  const inFlight = useRef<Promise<void> | null>(null);

  const confirmDelete = (): Promise<void> => {
    // Same double-click guard as the tour delete.
    if (inFlight.current) return inFlight.current;
    const pano = confirm;
    if (!pano) return Promise.resolve();
    const run = deletePano(pano)
      .then(() => setConfirm(null))
      .finally(() => {
        inFlight.current = null;
      });
    inFlight.current = run;
    return run;
  };

  return (
    <>
      {panos.length === 0 ? (
        // Free up space lands here at a limit, so say where else room comes from.
        <p className="unused__note">
          Every pano you’ve uploaded is in a tour. To make room, delete a tour you no longer need,
          or remove panos from a tour and delete them here.
        </p>
      ) : (
        <>
          <p className="unused__note">
            Panos none of your tours use, such as ones removed from a tour. Deleting one removes its
            image for good.
          </p>
          <ul className="unused__list">
            {panos.map((pano) => (
              <Row
                key={pano.panoId}
                pano={pano}
                thumb={coverImage(tilesBase, pano)}
                now={now}
                onDelete={setConfirm}
              />
            ))}
          </ul>
        </>
      )}
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
    </>
  );
}

/** The old /panos/unused page: now the dashboard with that filter on. */
export function UnusedPanosRedirect() {
  return <Navigate to={{ pathname: '/', search: '?view=unused' }} replace />;
}
