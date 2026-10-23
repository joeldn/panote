import { Button, cx } from '@internal/ui';
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
} from 'react';

import type { PendingUpload } from '../upload/upload-context.js';
import { findLink, yawDegrees, type EditorDocs } from './model.js';
import { pendingLine, pendingPct, type SceneStatus } from './scene-status.js';
import { dropIndex, keyMoveIndex, movedLine } from './scene-order.js';

// Each nudge turns a connection by this much (design: "nudge ±degrees").
export const NUDGE_DEG = 5;
const NUDGE = (NUDGE_DEG * Math.PI) / 180;

export interface TourPanelProps {
  docs: EditorDocs;
  currentId: string | null;
  startId: string | null;
  /** Unsaved edits: adding from the library waits for a save. */
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
  /** Moves a scene to index `to` of the list: the order visitors see the scenes in. */
  onMove?: (panoId: string, to: number) => void;
  /** Point the open pano's connection to `to` at the current view direction. */
  onAim: (to: string, title: string) => void;
  onNudge: (to: string, delta: number) => void;
  onDisconnect: (to: string) => void;
  /** Opens the library picker: add a pano that's already uploaded. */
  onAddFromLibrary?: () => void;
  /**
   * Opens the upload picker over the editor. Unsaved edits stay: each upload appends its
   * scene on the server and the editor folds it into the draft (useEditor's syncAppended).
   */
  onAddPano: () => void;
  /** Replace a pano's image in place (same panoId, new tiles): opens the file dialog. */
  onReplace: (panoId: string) => void;
}

const STATUS_LABEL: Record<SceneStatus, string> = {
  uploading: 'Uploading…',
  processing: 'Processing…',
  failed: 'Couldn’t process',
  'timed-out': 'Taking a while',
};

const noStatus = (): SceneStatus | null => null;

/** A scene being dragged by its handle, and the index it would land at. */
interface Drag {
  panoId: string;
  pointerId: number;
  from: number;
  to: number;
}

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
  onMove,
  onAim,
  onNudge,
  onDisconnect,
  onAddFromLibrary,
  onAddPano,
  onReplace,
}: TourPanelProps) {
  const scenes = docs.tour.current.scenes;
  const current = currentId ? docs.scenes[currentId] : undefined;
  const from = current?.kind === 'config' ? current.current : null;
  const reorder = onMove && scenes.length > 1 ? onMove : null;
  const keysId = useId();
  const list = useRef<HTMLUListElement>(null);
  const handles = useRef(new Map<string, HTMLButtonElement>());
  const [drag, setDrag] = useState<Drag | null>(null);
  // Numbered, so the same line twice in a row is new content the live region reads again.
  const [said, setSaid] = useState({ text: '', n: 0 });
  // A moved row is a moved DOM node, which drops focus: put it back on the row's handle.
  const refocus = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (!refocus.current) return;
    handles.current.get(refocus.current)?.focus();
    refocus.current = null;
  });

  const nameAt = (panoId: string): string => {
    const s = docs.scenes[panoId];
    return s?.kind === 'config' ? s.current.title : 'Missing pano';
  };
  const move = (panoId: string, to: number) => {
    if (!reorder) return;
    reorder(panoId, to);
    setSaid((s) => ({ text: movedLine(nameAt(panoId), to, scenes.length), n: s.n + 1 }));
  };
  // The rows' vertical middles, in list order (pending uploads aren't rows that move).
  const rowMids = (): number[] =>
    [...(list.current?.querySelectorAll<HTMLElement>(':scope > [data-scene]') ?? [])].map((el) => {
      const r = el.getBoundingClientRect();
      return r.top + r.height / 2;
    });
  const dragStart = (e: PointerEvent<HTMLButtonElement>, panoId: string, index: number) => {
    if (e.button !== 0 || !reorder) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    setDrag({ panoId, pointerId: e.pointerId, from: index, to: index });
  };
  const dragMove = (e: PointerEvent<HTMLButtonElement>) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const to = dropIndex(rowMids(), e.clientY, drag.from);
    if (to !== drag.to) setDrag({ ...drag, to });
  };
  const dragEnd = (e: PointerEvent<HTMLButtonElement>) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const to = dropIndex(rowMids(), e.clientY, drag.from);
    setDrag(null);
    if (to !== drag.from) move(drag.panoId, to);
  };
  // Esc drops a drag where it started.
  const dragging = drag !== null;
  useEffect(() => {
    if (!dragging) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') setDrag(null);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [dragging]);
  const keyMove = (e: KeyboardEvent<HTMLButtonElement>, panoId: string, index: number) => {
    const to = keyMoveIndex(e.key, index, scenes.length);
    if (to === null) return;
    e.preventDefault();
    refocus.current = panoId;
    move(panoId, to);
  };

  return (
    <section className="ed-card ed-tour" aria-labelledby="ed-tour-title">
      <header className="ed-card__head">
        <h2 id="ed-tour-title" className="ed-card__title">
          Tour <span className="ed-card__count">· {scenes.length} panos</span>
        </h2>
        <div className="ed-card__actions">
          {onAddFromLibrary && (
            <Button
              variant="ghost"
              size="sm"
              pill
              icon="fa-solid fa-images"
              aria-haspopup="dialog"
              disabled={dirty}
              title={dirty ? 'Save your changes first' : 'Add a pano you’ve already uploaded'}
              onClick={onAddFromLibrary}
            >
              From library
            </Button>
          )}
          <Button variant="accent" size="sm" pill icon="fa-solid fa-plus" onClick={onAddPano}>
            Add pano
          </Button>
        </div>
      </header>
      <p className="ed-hint">
        Click a pano to edit it. Connections point <b>from</b> the open pano: <b>Aim here</b> sets
        one to the current view.
        {reorder && <> Drag a pano by its handle to change the order visitors see.</>}
      </p>
      {reorder && (
        <p id={keysId} className="ed-sr">
          Arrow keys move it up or down the list, Home and End to the top or bottom.
        </p>
      )}
      <p className="ed-sr" aria-live="polite">
        <span key={said.n}>{said.text}</span>
      </p>
      <ul ref={list} className="ed-scenes">
        {scenes.map(({ panoId }, index) => {
          const s = docs.scenes[panoId];
          const missing = !s || s.kind === 'missing';
          const name = missing ? 'Missing pano' : s.current.title;
          const isCurrent = panoId === currentId;
          const link = from && !isCurrent ? findLink(from, panoId) : undefined;
          const status = missing ? null : statusOf(panoId);
          // A second image can't go over one that is still on its way.
          const busy = status === 'uploading' || status === 'processing';
          // Where the dragged row would land: a line above or below this one.
          const dropHere = drag && drag.to !== drag.from && drag.panoId !== panoId;
          const dropMark =
            dropHere && drag.to < drag.from && index === drag.to
              ? 'ed-scene--drop-before'
              : dropHere && drag.to > drag.from && index === drag.to
                ? 'ed-scene--drop-after'
                : null;
          return (
            <li
              key={panoId}
              data-scene={panoId}
              className={cx(
                'ed-scene',
                isCurrent && 'ed-scene--current',
                missing && 'ed-scene--missing',
                status && `ed-scene--${status}`,
                drag?.panoId === panoId && 'ed-scene--dragging',
                dropMark,
              )}
            >
              <div className="ed-scene__row">
                {reorder && (
                  <button
                    ref={(el) => {
                      if (el) handles.current.set(panoId, el);
                      else handles.current.delete(panoId);
                    }}
                    type="button"
                    className="ed-icon-btn ed-scene__grip"
                    aria-label={`Move ${name}, position ${index + 1} of ${scenes.length}`}
                    aria-describedby={keysId}
                    title="Drag to reorder"
                    onPointerDown={(e) => dragStart(e, panoId, index)}
                    onPointerMove={dragMove}
                    onPointerUp={dragEnd}
                    onPointerCancel={() => setDrag(null)}
                    onLostPointerCapture={() => setDrag(null)}
                    onKeyDown={(e) => keyMove(e, panoId, index)}
                  >
                    <i className="fa-solid fa-grip-vertical" aria-hidden="true" />
                  </button>
                )}
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
                  disabled={missing || status === 'uploading'}
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
                  <button
                    type="button"
                    className="ed-icon-btn"
                    aria-label={`Replace the image of ${name}`}
                    title="Replace image"
                    onClick={() => onReplace(panoId)}
                  >
                    <i className="fa-solid fa-camera" aria-hidden="true" />
                  </button>
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
        <p className="ed-hint ed-empty" role="note">
          This tour has no panos yet. <b>Add pano</b> uploads a 360° photo
          {onAddFromLibrary ? (
            <>
              , and <b>From library</b> reuses one you’ve already uploaded.
            </>
          ) : (
            '.'
          )}
        </p>
      )}
      {scenes.length === 1 && pending.length === 0 && (
        <p className="ed-hint ed-empty" role="note">
          Add a second pano to make a tour: visitors walk between connected panos with arrows on the
          floor.
        </p>
      )}
    </section>
  );
}
