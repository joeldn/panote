import type { PanoViewer } from '@panote/viewer';
import { useEffect, useLayoutEffect, useRef } from 'react';

import { usePanoViewer } from '../viewer-context.js';

/**
 * Run `cb` on every rendered frame of the stage's viewer. Chrome writes
 * transforms straight to DOM refs here instead of re-rendering React per frame.
 *
 * `cb` also runs once, before paint, when the viewer arrives and whenever
 * `items` changes: an idle viewer draws no frames, so without this a marker
 * added to the list would stay unplaced (and hidden) until the camera moved.
 */
export function useViewerFrame(
  cb: (viewer: PanoViewer) => void,
  items?: unknown,
): PanoViewer | null {
  const viewer = usePanoViewer();
  const latest = useRef(cb);
  // A layout effect, so the placement below already sees the new `cb`.
  useLayoutEffect(() => {
    latest.current = cb;
  });
  useLayoutEffect(() => {
    if (viewer) latest.current(viewer);
  }, [viewer, items]);
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
