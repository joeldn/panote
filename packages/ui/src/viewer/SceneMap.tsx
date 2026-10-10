import { useId, useState } from 'react';

import { cx } from '../cx.js';

export interface SceneMapEntry {
  id: string;
  title: string;
  /** Floor-plan position (tour `mapX`/`mapY`), any consistent units. */
  x?: number;
  y?: number;
}

export interface SceneMapProps {
  scenes: readonly SceneMapEntry[];
  current: string;
  onSelect: (id: string) => void;
}

type Placed = SceneMapEntry & { x: number; y: number };
const isPlaced = (s: SceneMapEntry): s is Placed => s.x !== undefined && s.y !== undefined;

// Normalises plan positions into 0..100% of the plan box.
const toPercent = (v: number, min: number, max: number) =>
  max === min ? 50 : 8 + ((v - min) / (max - min)) * 84;

/** The "Map" corner button and its panel: a floor plan when the tour has one, plus a scene list. */
export function SceneMap({ scenes, current, onSelect }: SceneMapProps) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const placed = scenes.filter(isPlaced);
  const xs = placed.map((s) => s.x);
  const ys = placed.map((s) => s.y);
  const [minX, maxX, minY, maxY] = [
    Math.min(...xs),
    Math.max(...xs),
    Math.min(...ys),
    Math.max(...ys),
  ];
  const select = (id: string) => {
    setOpen(false);
    if (id !== current) onSelect(id);
  };

  return (
    <div className="pn-scenemap">
      {open && (
        <div id={panelId} className="pn-scenemap__panel">
          {placed.length > 1 && (
            <div className="pn-scenemap__plan" aria-hidden="true">
              {placed.map((s) => (
                <span
                  key={s.id}
                  className={cx('pn-scenemap__dot', s.id === current && 'pn-scenemap__dot--on')}
                  style={{
                    left: `${toPercent(s.x, minX, maxX)}%`,
                    top: `${toPercent(s.y, minY, maxY)}%`,
                  }}
                />
              ))}
            </div>
          )}
          <ul className="pn-scenemap__list">
            {scenes.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  className="pn-scenemap__item"
                  aria-current={s.id === current ? 'location' : undefined}
                  onClick={() => select(s.id)}
                >
                  {s.title}
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
