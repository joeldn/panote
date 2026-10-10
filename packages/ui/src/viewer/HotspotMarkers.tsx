import { useLayoutEffect, useRef, type CSSProperties } from 'react';

import { cx } from '../cx.js';
import type { ViewerHotspot } from './types.js';
import { placeAt, useViewerFrame } from './use-render.js';

export interface HotspotMarkersProps {
  hotspots: readonly ViewerHotspot[];
  activeId?: string | null;
  onOpen: (hotspot: ViewerHotspot) => void;
}

/** Info-point markers pinned to their yaw/pitch; a click opens the point. */
export function HotspotMarkers({ hotspots, activeId, onOpen }: HotspotMarkersProps) {
  const refs = useRef(new Map<string, HTMLElement>());
  const viewer = useViewerFrame((v) => {
    for (const h of hotspots) placeAt(refs.current.get(h.id) ?? null, v.project(h.yaw, h.pitch));
  });
  // Markers start hidden until a frame places them, and the viewer only draws
  // when something changed: a new list on the same viewer asks for a frame.
  useLayoutEffect(() => {
    viewer?.requestRender();
  }, [viewer, hotspots]);

  return (
    <div className="pn-anchors" role="group" aria-label="Points of interest">
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
            title={h.title}
            onClick={() => onOpen(h)}
          >
            <i className={`fa-solid fa-${h.icon ?? 'info'}`} aria-hidden="true" />
          </button>
        </div>
      ))}
    </div>
  );
}
