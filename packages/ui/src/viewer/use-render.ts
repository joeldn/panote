import type { PanoViewerApi } from '@panote/viewer';
import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';

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
  cb: (viewer: PanoViewerApi) => void,
  items?: unknown,
): PanoViewerApi | null {
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

/** A laid-out size in CSS px, rewritten in place as it changes. */
export interface StageBox {
  width: number;
  height: number;
}

/**
 * The size of `ref`'s element (the chrome's layer, which covers the stage),
 * kept current by a ResizeObserver without a layout read per frame. A resize
 * asks the viewer for a frame, so markers are re-placed against the new size.
 * Reads 0×0 until it is measured. Read `.current` in frame callbacks only.
 */
export function useStageBox(ref: RefObject<HTMLElement | null>): RefObject<StageBox> {
  const viewer = usePanoViewer();
  const boxRef = useRef<StageBox>({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    const box = boxRef.current;
    if (!el) return;
    box.width = el.clientWidth;
    box.height = el.clientHeight;
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const rect = entries[entries.length - 1]?.contentRect;
      if (!rect) return;
      box.width = rect.width;
      box.height = rect.height;
      viewer?.requestRender();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, viewer]);
  return boxRef;
}

/**
 * Whether a projected point is on the stage, or within `margin` px of it (so a
 * marker centred there, `margin` being about half its size, still shows a
 * part). An unmeasured box counts everything as on stage.
 */
export function onStage(box: StageBox, x: number, y: number, margin: number): boolean {
  if (box.width <= 0 || box.height <= 0) return true;
  return x >= -margin && y >= -margin && x <= box.width + margin && y <= box.height + margin;
}

/**
 * Show or hide a placed element with `visibility`, which also takes its button
 * out of Tab order and the accessibility tree. Hiding the element that holds
 * focus would drop focus to <body>, so the viewer takes it first, as on a scene
 * change. Only a change touches the DOM or reads the focus: a frame where
 * nothing shows or hides does neither.
 */
export function setShown(el: HTMLElement, shown: boolean, viewer: PanoViewerApi): void {
  const visibility = shown ? 'visible' : 'hidden';
  if (el.style.visibility === visibility) return;
  if (!shown && el.contains(document.activeElement)) viewer.focus();
  el.style.visibility = visibility;
}

/**
 * Move `el` onto a projected point. It is hidden (see `setShown`) when the
 * point is behind the camera or off the stage `box` by more than `margin`.
 */
export function placeAt(
  viewer: PanoViewerApi,
  el: HTMLElement | null,
  point: { x: number; y: number; behind: boolean },
  box: StageBox,
  margin: number,
  extra = '',
): void {
  if (!el) return;
  const shown = !point.behind && onStage(box, point.x, point.y, margin);
  setShown(el, shown, viewer);
  if (shown) el.style.transform = `translate(${point.x}px, ${point.y}px)${extra}`;
}
