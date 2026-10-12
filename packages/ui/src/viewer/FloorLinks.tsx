import { useRef } from 'react';

import type { ViewerLinkArrow } from './types.js';
import { onStage, setShown, useStageBox, useViewerFrame } from './use-render.js';

// Two floor points along the link's heading: near the feet and toward the horizon.
const PITCH_NEAR = -0.6;
const PITCH_FAR = -0.2;
// A chevron is a 56 px disc, scaled by up to 1.5. Its floor tilt (viewer.css)
// leaves it about as wide, so its outer edge is 42 px from its centre, 45 px
// with its 2 px ring and 48 px with the focus outline: a chevron centred this
// far past the stage edge still shows a sliver.
const EDGE_MARGIN = 48;

export interface FloorLinksProps {
  links: readonly ViewerLinkArrow[];
  onGo: (link: ViewerLinkArrow) => void;
}

/** Floor chevrons to linked scenes, laid along the floor and foreshortened with zoom. */
export function FloorLinks({ links, onGo }: FloorLinksProps) {
  const refs = useRef(new Map<string, HTMLElement>());
  const layer = useRef<HTMLDivElement>(null);
  const box = useStageBox(layer);
  useViewerFrame((v) => {
    for (const link of links) {
      const el = refs.current.get(link.to);
      if (!el) continue;
      const near = v.project(link.yaw, PITCH_NEAR);
      const far = v.project(link.yaw, PITCH_FAR);
      // Either point behind the camera projects mirrored, so the chevron
      // built from it would land in the wrong place or flipped.
      const behind = near.behind || far.behind;
      const x = (near.x + far.x) / 2;
      const y = (near.y + far.y) / 2;
      // Off the stage, the button would still take Tab focus and be read out.
      const shown = !behind && onStage(box.current, x, y, EDGE_MARGIN);
      setShown(el, shown, v);
      if (!shown) continue;
      const dx = far.x - near.x;
      const dy = far.y - near.y;
      const angle = Math.atan2(dx, -dy);
      const scale = Math.max(0.5, Math.min(1.5, Math.hypot(dx, dy) / 90));
      el.style.transform = `translate(${x}px, ${y}px) rotate(${angle}rad) scale(${scale})`;
    }
  }, links);

  return (
    <div ref={layer} className="pn-anchors" role="group" aria-label="Go to">
      {links.map((link) => (
        <div
          key={link.to}
          className="pn-anchor"
          ref={(el) => {
            if (el) refs.current.set(link.to, el);
            else refs.current.delete(link.to);
          }}
        >
          <button
            type="button"
            className="pn-floorlink"
            aria-label={`Go to ${link.label}`}
            title={link.label}
            onClick={() => onGo(link)}
          >
            <i className="fa-solid fa-angles-up" aria-hidden="true" />
          </button>
        </div>
      ))}
    </div>
  );
}
