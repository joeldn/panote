import { fitMapPositions, type MapPoint } from '@internal/contracts';
import { useId, useMemo, useRef, useState, type CSSProperties } from 'react';

import { cx } from '../cx.js';
import { useViewerFrame } from './use-render.js';

export interface SceneMapEntry {
  id: string;
  title: string;
  /**
   * Floor-plan position (tour `mapX`/`mapY`): 0..1 fractions of the plan, x right
   * and y down. Older tours' other units are fitted to the plan (see contracts plan.ts).
   */
  x?: number;
  y?: number;
  /** The scene's north is set, so the view's facing can be drawn on its dot. */
  hasNorth?: boolean;
}

/** The floor-plan image behind the dots. */
export interface SceneMapPlan {
  url: string;
  width: number;
  height: number;
}

export interface SceneMapProps {
  scenes: readonly SceneMapEntry[];
  /** The scene on screen. */
  current: string;
  /**
   * The scene a change in flight is heading to. Choosing it again does
   * nothing, while choosing `current` goes back (cancelling the change).
   */
  pending?: string;
  plan?: SceneMapPlan | null;
  onSelect: (id: string) => void;
}

type Placed = SceneMapEntry & MapPoint;

/** Turns with the view: which way the current scene's view faces, north at the top. */
function Facing() {
  const cone = useRef<HTMLSpanElement>(null);
  useViewerFrame((viewer) => {
    // heading() is north relative to the view, so the view relative to north is its negative.
    if (cone.current) cone.current.style.transform = `rotate(${-viewer.heading()}rad)`;
  });
  return <span ref={cone} className="pn-scenemap__facing" aria-hidden="true" />;
}

/** The "Map" corner button and its panel: a floor plan when the tour has one, plus a scene list. */
export function SceneMap({ scenes, current, pending, plan, onSelect }: SceneMapProps) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const placed = useMemo<Placed[]>(() => {
    const raw = new Map<string, MapPoint>();
    for (const s of scenes) if (s.x !== undefined && s.y !== undefined) raw.set(s.id, s as Placed);
    const fitted = fitMapPositions(raw);
    return scenes.flatMap((s) => {
      const at = fitted.get(s.id);
      return at ? [{ ...s, ...at }] : [];
    });
  }, [scenes]);
  // Dots alone need two to say anything; on a plan image one already does.
  const showPlan = placed.length > 1 || (placed.length > 0 && !!plan);
  const select = (id: string) => {
    setOpen(false);
    if (id !== (pending ?? current)) onSelect(id);
  };
  const isPending = (id: string) => id === pending && id !== current;

  return (
    <div className="pn-scenemap">
      {open && (
        <div id={panelId} className="pn-scenemap__panel">
          {showPlan && (
            <div
              className={cx('pn-scenemap__plan', plan && 'pn-scenemap__plan--image')}
              role="group"
              aria-label="Floor plan"
              style={
                plan
                  ? ({ '--pn-plan-ratio': plan.width / plan.height } as CSSProperties)
                  : undefined
              }
            >
              {plan && <img className="pn-scenemap__img" src={plan.url} alt="" draggable={false} />}
              {placed.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  className={cx(
                    'pn-scenemap__dot',
                    s.id === current && 'pn-scenemap__dot--on',
                    isPending(s.id) && 'pn-scenemap__dot--pending',
                  )}
                  style={{ left: `${s.x * 100}%`, top: `${s.y * 100}%` }}
                  aria-label={isPending(s.id) ? `${s.title}, loading` : s.title}
                  aria-current={s.id === current ? 'location' : undefined}
                  aria-busy={isPending(s.id) ? true : undefined}
                  title={s.title}
                  onClick={() => select(s.id)}
                >
                  {s.id === current && s.hasNorth && <Facing />}
                </button>
              ))}
            </div>
          )}
          <ul className="pn-scenemap__list">
            {scenes.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  className={cx(
                    'pn-scenemap__item',
                    isPending(s.id) && 'pn-scenemap__item--pending',
                  )}
                  aria-current={s.id === current ? 'location' : undefined}
                  aria-busy={isPending(s.id) ? true : undefined}
                  onClick={() => select(s.id)}
                >
                  {s.title}
                  {isPending(s.id) && (
                    <>
                      <span className="pn-scenemap__spinner" aria-hidden="true" />
                      <span className="pn-sr-only">, loading</span>
                    </>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <button
        type="button"
        className="pn-scenemap__toggle"
        aria-expanded={open}
        // Only while open: the panel isn't in the DOM when closed.
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((o) => !o)}
      >
        <i className="fa-solid fa-table-cells-large" aria-hidden="true" />
        Map
      </button>
    </div>
  );
}
