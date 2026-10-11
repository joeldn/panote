import { useRef, type CSSProperties } from 'react';

import { cx } from '../cx.js';
import { pointIcon } from '../icons/names.js';
import type { ViewerHotspot } from './types.js';
import { placeAt, useStageBox, useViewerFrame } from './use-render.js';

// Half a size-1 marker (34 px) plus its shadow: a marker with its point this
// far past the stage edge still shows a sliver. Scales with `size`.
const EDGE_MARGIN = 20;

export interface HotspotMarkersProps {
  hotspots: readonly ViewerHotspot[];
  activeId?: string | null;
  onOpen: (hotspot: ViewerHotspot) => void;
}

/** Info-point markers pinned to their yaw/pitch; a click opens the point. */
export function HotspotMarkers({ hotspots, activeId, onOpen }: HotspotMarkersProps) {
  const refs = useRef(new Map<string, HTMLElement>());
  const layer = useRef<HTMLDivElement>(null);
  const box = useStageBox(layer);
  useViewerFrame((v) => {
    for (const h of hotspots) {
      const el = refs.current.get(h.id) ?? null;
      placeAt(el, v.project(h.yaw, h.pitch), box.current, EDGE_MARGIN * (h.size ?? 1));
    }
  }, hotspots);

  return (
    <div ref={layer} className="pn-anchors" role="group" aria-label="Points of interest">
      {hotspots.map((h) => (
        <div
          key={h.id}
          className="pn-anchor"
          ref={(el) => {
            if (el) refs.current.set(h.id, el);
            else refs.current.delete(h.id);
          }}
        >
          <button
            type="button"
            className={cx('pn-hotspot', activeId === h.id && 'pn-hotspot--active')}
            style={{ '--pn-hs-scale': h.size ?? 1 } as CSSProperties}
            aria-label={h.title}
            aria-pressed={activeId === h.id}
            // HotspotPanel finds its marker by this to hand focus back on close.
            data-hotspot-id={h.id}
            title={h.title}
            onClick={() => onOpen(h)}
          >
            <i className={`fa-solid fa-${pointIcon(h.icon)}`} aria-hidden="true" />
          </button>
        </div>
      ))}
    </div>
  );
}
