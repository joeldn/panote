import type { MapPoint, TourDoc } from '@internal/contracts';
import { Button, cx } from '@internal/ui';
import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from 'react';

import { suggestForTour } from './map-suggest.js';
import { editorReducer, mapPositions, sameValue, type EditorDocs } from './model.js';
import { PanelCard } from './PanelCard.js';
import { setPanelOpen } from './panels.js';

// The plan's shape without an image: the viewer's map box is 220×140 px (packages/ui
// styles/viewer.css), so a dot sits in the same place in both.
const BARE_RATIO = 220 / 140;
// Arrow keys move a dot by 1% of the plan; with Shift, 5%.
export const MAP_STEP = 0.01;
export const MAP_STEP_BIG = 0.05;
// A press that moves less than this (px) is a click, not a drag.
const DRAG_SLOP = 4;

export interface MapPanelPlan {
  url: string;
  width: number;
  height: number;
}

export interface MapPanelProps {
  docs: EditorDocs;
  currentId: string | null;
  /** The floor-plan image, if the tour has one. */
  plan: MapPanelPlan | null;
  /** Visitors see the map (the tour's `showMap` setting). */
  shown: boolean;
  onShownChange: (shown: boolean) => void;
  /** A plan image is being prepared or uploaded. */
  uploading?: boolean;
  /** Why the last plan image couldn't be added, for the user. */
  planError?: string | null;
  onPlace: (panoId: string, x: number, y: number) => void;
  onRemove: (panoId: string) => void;
  /** Puts the unplaced panos where "Suggest positions" worked out, as one edit. */
  onSuggest: (positions: Record<string, MapPoint>) => void;
  /** Opens a pano in the editor. */
  onSelect: (panoId: string) => void;
  onPlanFile: (file: File) => void;
  onRemovePlan: () => void;
}

interface Drag {
  panoId: string;
  pointerId: number;
  startX: number;
  startY: number;
  moved: boolean;
  at: MapPoint | null;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const pct = (v: number) => Math.round(v * 100);

// Where a new dot goes: the middle, or the first spot near it no other dot is on.
function freeSpot(taken: Iterable<MapPoint>): MapPoint {
  const others = [...taken];
  const spots = [0, 0.08, -0.08, 0.16, -0.16].flatMap((dy) =>
    [0, 0.08, -0.08, 0.16, -0.16].map((dx) => ({ x: 0.5 + dx, y: 0.5 + dy })),
  );
  return (
    spots.find((s) => others.every((o) => Math.hypot(o.x - s.x, o.y - s.y) > 0.04)) ?? spots[0]!
  );
}

/**
 * The editor's "Map" card: the floor plan, where each pano is placed by dragging its dot
 * (or with the arrow keys), plus the plan image behind them. Its head has the switch that
 * shows the map to visitors. Folded until opened.
 */
export function MapPanel({
  docs,
  currentId,
  plan,
  shown,
  onShownChange,
  uploading = false,
  planError = null,
  onPlace,
  onRemove,
  onSuggest,
  onSelect,
  onPlanFile,
  onRemovePlan,
}: MapPanelProps) {
  // What the last "Suggest positions" did, for the line under the button, and the tour
  // it left: any later edit (a drag, a remove, an undo) makes the line stale.
  const [suggested, setSuggested] = useState<{ text: string; tour: TourDoc } | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const focusDot = useRef<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const keysId = useId();
  const tour = docs.tour.current;
  const positions = mapPositions(tour);
  const nameOf = (panoId: string) => {
    const s = docs.scenes[panoId];
    return s?.kind === 'config' ? s.current.title : 'Missing pano';
  };
  const current = currentId && docs.scenes[currentId]?.kind === 'config' ? currentId : null;
  const currentPlaced = current !== null && positions.has(current);

  // A dot just placed from the button takes focus, so the arrow keys can move it. Every
  // render: the dot shows up once the parent has applied the placing. Dropped if another
  // pano opens first.
  useEffect(() => {
    const id = focusDot.current;
    if (!id) return;
    if (id !== currentId) {
      focusDot.current = null;
      return;
    }
    const dots = box.current?.querySelectorAll<HTMLElement>('[data-pano]') ?? [];
    const placed = [...dots].find((d) => d.dataset.pano === id);
    if (!placed) return;
    placed.focus();
    focusDot.current = null;
  });

  const fraction = (clientX: number, clientY: number): MapPoint => {
    const r = box.current?.getBoundingClientRect();
    if (!r || r.width <= 0 || r.height <= 0) return { x: 0.5, y: 0.5 };
    return { x: clamp01((clientX - r.left) / r.width), y: clamp01((clientY - r.top) / r.height) };
  };

  const down = (e: PointerEvent<HTMLButtonElement>, panoId: string) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    setDrag({
      panoId,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      moved: false,
      at: null,
    });
  };
  const move = (e: PointerEvent<HTMLButtonElement>) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const moved =
      drag.moved || Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) > DRAG_SLOP;
    if (moved) setDrag({ ...drag, moved, at: fraction(e.clientX, e.clientY) });
  };
  const up = (e: PointerEvent<HTMLButtonElement>) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    setDrag(null);
    if (drag.moved) {
      const at = fraction(e.clientX, e.clientY);
      onPlace(drag.panoId, at.x, at.y);
    } else {
      onSelect(drag.panoId);
    }
  };
  // A click with no pointer press before it: the keyboard (Enter or Space).
  const clickDot = (e: MouseEvent<HTMLButtonElement>, panoId: string) => {
    e.stopPropagation();
    if (e.detail === 0) onSelect(panoId);
  };
  const keyDot = (e: KeyboardEvent<HTMLButtonElement>, panoId: string, at: MapPoint) => {
    const step = e.shiftKey ? MAP_STEP_BIG : MAP_STEP;
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    const d = moves[e.key];
    if (d) {
      e.preventDefault();
      onPlace(panoId, clamp01(at.x + d[0]), clamp01(at.y + d[1]));
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      onRemove(panoId);
      box.current?.focus();
    }
  };
  // A click on the plan itself puts the open pano there.
  const clickPlan = (e: MouseEvent<HTMLDivElement>) => {
    if (!current || (e.target as HTMLElement).closest('.ed-map__dot')) return;
    const at = fraction(e.clientX, e.clientY);
    onPlace(current, at.x, at.y);
  };
  const placeCurrent = () => {
    if (!current) return;
    const at = freeSpot([...positions].filter(([id]) => id !== current).map(([, p]) => p));
    onPlace(current, at.x, at.y);
    focusDot.current = current;
  };

  const placedCount = tour.scenes.filter((s) => positions.has(s.panoId)).length;
  const ratio = plan ? plan.width / plan.height : BARE_RATIO;

  const suggest = () => {
    const out = suggestForTour(docs, ratio);
    const n = out.positions.size;
    if (!n) return;
    const positions = Object.fromEntries(out.positions);
    onSuggest(positions);
    const after = editorReducer(docs, { type: 'map/suggest', positions })!.tour.current;
    const panos = n === 1 ? '1 pano' : `${n} panos`;
    const lines = [
      out.fromLinks === 0
        ? `Placed ${panos}.`
        : out.fromLinks === n
          ? `Placed ${panos} from their links.`
          : `Placed ${panos}, ${out.fromLinks} from their links.`,
      n === 1 ? 'Drag it if it’s off.' : 'Drag any that are off.',
    ];
    if (out.noDirection > 0) lines.push('Set North is here on more panos for better suggestions.');
    setSuggested({ text: lines.join(' '), tour: after });
  };
  const status = suggested && sameValue(suggested.tour, tour) ? suggested.text : null;

  return (
    <PanelCard
      panel="map"
      className="ed-map"
      count={
        <span className="ed-card__count">
          · {placedCount} of {tour.scenes.length} placed
        </span>
      }
      actions={
        <label className="ed-switch" title="Show the map to visitors">
          <span className="ed-sr">Show the map to visitors</span>
          <input
            type="checkbox"
            role="switch"
            checked={shown}
            onChange={(e) => {
              onShownChange(e.target.checked);
              // Turned on: open the card to place the panos.
              if (e.target.checked) setPanelOpen('map', true);
            }}
          />
        </label>
      }
      onToggle={() => setSuggested(null)}
    >
      {placedCount === 0 && (
        <p className="ed-hint">
          Drag each pano to where it was taken, or click the plan to put the open pano there. Keep
          north at the top.
        </p>
      )}
      <p id={keysId} className="ed-sr">
        Arrow keys move it, Shift for bigger steps. Delete takes it off the map.
      </p>
      <div className="ed-map__frame">
        <div
          ref={box}
          className={cx(
            'ed-map__plan',
            plan && 'ed-map__plan--image',
            current && 'ed-map__plan--placing',
          )}
          style={{ '--ed-map-ratio': ratio } as CSSProperties}
          role="group"
          aria-label="Floor plan"
          tabIndex={-1}
          onClick={clickPlan}
        >
          {plan && <img className="ed-map__img" src={plan.url} alt="" draggable={false} />}
          {[...positions].map(([panoId, stored]) => {
            const at = drag?.panoId === panoId && drag.at ? drag.at : stored;
            const name = nameOf(panoId);
            return (
              <button
                key={panoId}
                type="button"
                data-pano={panoId}
                className={cx(
                  'ed-map__dot',
                  panoId === currentId && 'ed-map__dot--current',
                  drag?.panoId === panoId && drag.moved && 'ed-map__dot--dragging',
                )}
                style={{ left: `${at.x * 100}%`, top: `${at.y * 100}%` }}
                aria-label={`${name}, ${pct(at.x)}% across, ${pct(at.y)}% down`}
                aria-describedby={keysId}
                aria-current={panoId === currentId ? 'true' : undefined}
                title={name}
                onPointerDown={(e) => down(e, panoId)}
                onPointerMove={move}
                onPointerUp={up}
                onPointerCancel={() => setDrag(null)}
                onLostPointerCapture={() => setDrag(null)}
                onClick={(e) => clickDot(e, panoId)}
                onKeyDown={(e) => keyDot(e, panoId, stored)}
              >
                <span className="ed-map__label" aria-hidden="true">
                  {name}
                </span>
              </button>
            );
          })}
        </div>
      </div>
      <div className="ed-map__suggest">
        <Button
          variant="ghost"
          size="sm"
          pill
          icon="fa-solid fa-diagram-project"
          disabled={placedCount === tour.scenes.length}
          onClick={suggest}
        >
          Suggest positions
        </Button>
        <p className="ed-hint ed-map__suggested" role="status">
          {status}
        </p>
      </div>
      {current && (
        <div className="ed-map__row" role="group" aria-label="Open pano on the map">
          <span className="ed-map__name">{nameOf(current)}</span>
          {currentPlaced ? (
            <button type="button" className="ed-conn__aim" onClick={() => onRemove(current)}>
              <i className="fa-solid fa-xmark" aria-hidden="true" /> Remove from map
            </button>
          ) : (
            <button type="button" className="ed-conn__aim" onClick={placeCurrent}>
              <i className="fa-solid fa-location-dot" aria-hidden="true" /> Place on map
            </button>
          )}
        </div>
      )}
      <input
        ref={file}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="ed-sr"
        tabIndex={-1}
        aria-hidden="true"
        data-testid="plan-input"
        onChange={(e) => {
          const picked = e.target.files?.[0];
          e.target.value = '';
          if (picked) onPlanFile(picked);
        }}
      />
      {plan ? (
        // Replacing or removing the image only means something once there is one.
        <div className="ed-map__image" role="group" aria-label="Plan image">
          <span className="ed-label">Plan image</span>
          <Button
            variant="ghost"
            size="sm"
            pill
            icon="fa-solid fa-image"
            busy={uploading}
            disabled={uploading}
            onClick={() => file.current?.click()}
          >
            {uploading ? 'Adding…' : 'Replace'}
          </Button>
          {!uploading && (
            <Button variant="ghost" size="sm" pill onClick={onRemovePlan}>
              Remove
            </Button>
          )}
        </div>
      ) : (
        <div className="ed-map__image">
          <Button
            variant="ghost"
            size="sm"
            pill
            icon="fa-solid fa-image"
            busy={uploading}
            disabled={uploading}
            aria-describedby={`${keysId}-plan`}
            onClick={() => file.current?.click()}
          >
            {uploading ? 'Adding…' : 'Add plan image'}
          </Button>
          <span id={`${keysId}-plan`} className="ed-map__fine">
            JPG, PNG or WebP
          </span>
        </div>
      )}
      {planError && (
        <p className="ed-note ed-note--error ed-map__error" role="alert">
          {planError}
        </p>
      )}
    </PanelCard>
  );
}
