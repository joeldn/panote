import { useRef } from 'react';

import { useViewerFrame } from './use-render.js';

/** Compass needle that turns with the view; north comes from the scene's offset. */
export function Compass({ className }: { className?: string }) {
  const needle = useRef<HTMLSpanElement>(null);
  useViewerFrame((viewer) => {
    if (needle.current) needle.current.style.transform = `rotate(${viewer.heading()}rad)`;
  });
  return (
    <div className={`pn-compass ${className ?? ''}`.trim()} role="img" aria-label="Compass">
      <span ref={needle} className="pn-compass__needle">
        <i className="fa-solid fa-location-arrow" aria-hidden="true" />
      </span>
    </div>
  );
}
