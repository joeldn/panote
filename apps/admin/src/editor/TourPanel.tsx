import { Button, cx } from '@internal/ui';
import type { CSSProperties } from 'react';
import { Link } from 'react-router';

import type { PendingUpload } from '../upload/upload-context.js';
import { findLink, yawDegrees, type EditorDocs } from './model.js';
import { pendingLine, pendingPct, type SceneStatus } from './scene-status.js';
import { addPanoPath, replaceImagePath } from './upload-links.js';

// Each nudge turns a connection by this much (design: "nudge ±degrees").
export const NUDGE_DEG = 5;
const NUDGE = (NUDGE_DEG * Math.PI) / 180;

export interface TourPanelProps {
  docs: EditorDocs;
  currentId: string | null;
  startId: string | null;
  /** Unsaved edits: adding a pano leaves the editor, so it waits for a save. */
  dirty: boolean;
  /** Uploads into this tour that have no scene yet, oldest first. */
  pending?: PendingUpload[];
  /** A scene whose tiles aren't in (uploading, processing, failed, timed out), else null. */
  statusOf?: (panoId: string) => SceneStatus | null;
  /** The open pano is look-only: its connections can't be changed yet. */
  lookOnly?: boolean;
  onSelect: (panoId: string) => void;
  onSetStart: (panoId: string) => void;
  onRemove: (panoId: string) => void;
  /** Point the open pano's connection to `to` at the current view direction. */
  onAim: (to: string, title: string) => void;
  onNudge: (to: string, delta: number) => void;
  onDisconnect: (to: string) => void;
}

const STATUS_LABEL: Record<SceneStatus, string> = {
  uploading: 'Uploading…',
  processing: 'Processing…',
  failed: 'Couldn’t process',
  'timed-out': 'Taking a while',
};

const noStatus = (): SceneStatus | null => null;

const hueOf = (id: string): number => [...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 0);

/** Screen 04's "Tour" card: the scene list, entry scene, and connections from the open pano. */
export function TourPanel({
  docs,
  currentId,
  startId,
  dirty,
  pending = [],
  statusOf = noStatus,
  lookOnly = false,
  onSelect,
  onSetStart,
  onRemove,
  onAim,
  onNudge,
  onDisconnect,
}: TourPanelProps) {
  const scenes = docs.tour.current.scenes;
  const current = currentId ? docs.scenes[currentId] : undefined;
  const from = current?.kind === 'config' ? current.current : null;

  return (
    <section className="ed-card ed-tour" aria-labelledby="ed-tour-title">
      <header className="ed-card__head">
        <h2 id="ed-tour-title" className="ed-card__title">
          Tour <span className="ed-card__count">· {scenes.length} panos</span>
        </h2>
        {dirty ? (
          <Button
            variant="accent"
            size="sm"
            pill
            icon="fa-solid fa-plus"
            disabled
            title="Save your changes first"
          >
            Add pano
          </Button>
        ) : (
          <Link
            className="pn-btn pn-btn--accent pn-btn--sm pn-btn--pill"
            to={addPanoPath(docs.tourId)}
          >
            <i className="fa-solid fa-plus" aria-hidden="true" /> Add pano
          </Link>
        )}
      </header>
      <p className="ed-hint">
        Click a pano to edit it. Connections point <b>from</b> the open pano — <b>Aim here</b> sets
        one to the current view.
      </p>
      <ul className="ed-scenes">
        {scenes.map(({ panoId }) => {
          const s = docs.scenes[panoId];
          const missing = !s || s.kind === 'missing';
          const name = missing ? 'Missing pano' : s.current.title;
          const isCurrent = panoId === currentId;
          const link = from && !isCurrent ? findLink(from, panoId) : undefined;
          const status = missing ? null : statusOf(panoId);
          // A second image can't go over one that is still on its way.
          const busy = status === 'uploading' || status === 'processing';
          return (
            <li
              key={panoId}
              className={cx(
                'ed-scene',
                isCurrent && 'ed-scene--current',
                missing && 'ed-scene--missing',
                status && `ed-scene--${status}`,
              )}
            >
              <div className="ed-scene__row">
                <button
                  type="button"
                  className="ed-scene__open"
                  aria-current={isCurrent ? 'true' : undefined}
                  onClick={() => onSelect(panoId)}
                >
                  <span
                    className="ed-scene__thumb"
                    style={{ '--hue': hueOf(panoId) } as CSSProperties}
                    aria-hidden="true"
                  >
                    {missing ? <i className="fa-solid fa-image" /> : name.slice(0, 1).toUpperCase()}
                  </span>
                  <span className="ed-scene__name">{name}</span>
                  {missing && (
                    <span className="ed-scene__sub">
                      {s?.kind === 'missing' && s.deleting ? 'Being deleted' : 'Deleted'}
                    </span>
                  )}
                  {status && <span className="ed-scene__sub">{STATUS_LABEL[status]}</span>}
                </button>
                <button
                  type="button"
                  className={cx('ed-scene__star', panoId === startId && 'ed-scene__star--on')}
                  aria-pressed={panoId === startId}
                  aria-label={`Start the tour at ${name}`}
                  title="Tour starts here"
                  disabled={missing}
                  onClick={() => onSetStart(panoId)}
                >
                  <i className="fa-solid fa-star" aria-hidden="true" />
                </button>
                {!missing && busy && (
                  <button
                    type="button"
                    className="ed-icon-btn"
                    aria-label={`Replace the image of ${name}`}
                    title="You can replace the image once it’s ready"
                    disabled
                  >
                    <i className="fa-solid fa-camera" aria-hidden="true" />
                  </button>
                )}
                {!missing && !busy && (
                  <Link
                    className="ed-icon-btn"
                    to={replaceImagePath(docs.tourId, panoId)}
                    aria-label={`Replace the image of ${name}`}
                    title="Replace image"
                  >
                    <i className="fa-solid fa-camera" aria-hidden="true" />
                  </Link>
                )}
                {isCurrent && <span className="ed-scene__badge">Current</span>}
                <button
                  type="button"
                  className="ed-icon-btn ed-scene__remove"
                  aria-label={`Remove ${name} from tour`}
                  title="Remove from tour"
                  onClick={() => onRemove(panoId)}
                >
                  <i className="fa-solid fa-xmark" aria-hidden="true" />
                </button>
              </div>
              {from && !isCurrent && !missing && (
                <div className="ed-conn" role="group" aria-label={`Connection to ${name}`}>
                  <i className="fa-solid fa-diamond-turn-right ed-conn__icon" aria-hidden="true" />
                  {link ? (
                    <>
                      <span className="ed-conn__label">connection</span>
                      <span className="ed-conn__deg">{yawDegrees(link.yaw)}°</span>
                      <button
                        type="button"
                        className="ed-icon-btn ed-conn__nudge"
                        disabled={lookOnly}
                        aria-label={`Nudge left ${NUDGE_DEG}°`}
                        onClick={() => onNudge(panoId, -NUDGE)}
                      >
                        <i className="fa-solid fa-chevron-left" aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        className="ed-icon-btn ed-conn__nudge"
                        disabled={lookOnly}
                        aria-label={`Nudge right ${NUDGE_DEG}°`}
                        onClick={() => onNudge(panoId, NUDGE)}
                      >
                        <i className="fa-solid fa-chevron-right" aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        className="ed-conn__aim"
                        disabled={lookOnly}
                        onClick={() => onAim(panoId, name)}
                      >
                        <i className="fa-solid fa-crosshairs" aria-hidden="true" /> Aim
                      </button>
                      <button
                        type="button"
                        className="ed-icon-btn"
                        disabled={lookOnly}
                        aria-label={`Remove connection to ${name}`}
                        onClick={() => onDisconnect(panoId)}
                      >
                        <i className="fa-solid fa-xmark" aria-hidden="true" />
                      </button>
                    </>
                  ) : (
                    <>
                      <span className="ed-conn__label">not connected</span>
                      <button
                        type="button"
                        className="ed-conn__aim"
                        disabled={lookOnly}
                        onClick={() => onAim(panoId, name)}
                      >
                        <i className="fa-solid fa-crosshairs" aria-hidden="true" /> Aim here
                      </button>
                    </>
                  )}
                </div>
              )}
            </li>
          );
        })}
        {pending.map((p) => {
          const pct = pendingPct(p);
          const isCurrent = p.panoId !== null && p.panoId === currentId;
          return (
            <li
              key={p.key}
              className={cx('ed-scene', 'ed-scene--pending', isCurrent && 'ed-scene--current')}
            >
              <div className="ed-scene__row">
                <button
                  type="button"
                  className="ed-scene__open"
                  aria-current={isCurrent ? 'true' : undefined}
                  disabled={p.panoId === null}
                  onClick={() => p.panoId && onSelect(p.panoId)}
                >
                  <span className="ed-scene__thumb ed-scene__thumb--pending" aria-hidden="true">
                    <i className="fa-solid fa-cloud-arrow-up" />
                  </span>
                  <span className="ed-pending__name">{p.fileName}</span>
                  <span className="ed-scene__sub">{pendingLine(p)}</span>
                </button>
                {isCurrent && <span className="ed-scene__badge">Current</span>}
              </div>
              {pct !== null && (
                <div
                  className="ed-scene__bar"
                  role="progressbar"
                  aria-label={`Uploading ${p.fileName}`}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={pct}
                >
                  <span style={{ width: `${pct}%` }} />
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {scenes.length === 0 && pending.length === 0 && (
        <p className="ed-hint">This tour has no panos yet.</p>
      )}
    </section>
  );
}
