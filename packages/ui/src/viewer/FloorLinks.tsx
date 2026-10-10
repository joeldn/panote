import { useLayoutEffect, useRef } from 'react';

import type { ViewerLinkArrow } from './types.js';
import { useViewerFrame } from './use-render.js';

// Two floor points along the link's heading: near the feet and toward the horizon.
const PITCH_NEAR = -0.6;
const PITCH_FAR = -0.2;

export interface FloorLinksProps {
  links: readonly ViewerLinkArrow[];
  onGo: (link: ViewerLinkArrow) => void;
}

/** Floor chevrons to linked scenes, laid along the floor and foreshortened with zoom. */
export function FloorLinks({ links, onGo }: FloorLinksProps) {
  const refs = useRef(new Map<string, HTMLElement>());
  const viewer = useViewerFrame((v) => {
    for (const link of links) {
      const el = refs.current.get(link.to);
      if (!el) continue;
      const near = v.project(link.yaw, PITCH_NEAR);
      const far = v.project(link.yaw, PITCH_FAR);
      // Either point behind the camera projects mirrored, so the chevron
      // built from it would land in the wrong place or flipped.
      const behind = near.behind || far.behind;
      el.style.visibility = behind ? 'hidden' : 'visible';
      if (behind) continue;
      const dx = far.x - near.x;
      const dy = far.y - near.y;
      const angle = Math.atan2(dx, -dy);
      const scale = Math.max(0.5, Math.min(1.5, Math.hypot(dx, dy) / 90));
      const x = (near.x + far.x) / 2;
      const y = (near.y + far.y) / 2;
      el.style.transform = `translate(${x}px, ${y}px) rotate(${angle}rad) scale(${scale})`;
    }
  });
  // Chevrons start hidden until a frame places them, and the viewer only draws
  // when something changed: a new list on the same viewer asks for a frame.
  useLayoutEffect(() => {
    viewer?.requestRender();
  }, [viewer, links]);

  return (
    <div className="pn-anchors" role="group" aria-label="Go to">
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
