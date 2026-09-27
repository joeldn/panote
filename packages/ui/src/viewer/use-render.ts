import type { PanoViewer } from '@panote/viewer';
import { useEffect, useRef } from 'react';

import { usePanoViewer } from '../viewer-context.js';

/**
 * Run `cb` on every rendered frame of the stage's viewer. Chrome writes
 * transforms straight to DOM refs here instead of re-rendering React per frame.
 */
export function useViewerFrame(cb: (viewer: PanoViewer) => void): PanoViewer | null {
  const viewer = usePanoViewer();
  const latest = useRef(cb);
  useEffect(() => {
    latest.current = cb;
  });
  useEffect(() => {
    if (!viewer) return;
    return viewer.onRender(() => latest.current(viewer));
  }, [viewer]);
  return viewer;
}

/** Move `el` onto a projected point, hiding it when the point is behind the camera. */
export function placeAt(
  el: HTMLElement | null,
  point: { x: number; y: number; behind: boolean },
  extra = '',
): void {
  if (!el) return;
  el.style.visibility = point.behind ? 'hidden' : 'visible';
  if (!point.behind) el.style.transform = `translate(${point.x}px, ${point.y}px)${extra}`;
}
