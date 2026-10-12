/**
 * Helpers for CameraRig tests: a rig built from viewer options, its private
 * state opened up, and a frame clock that steps it as PanoViewer's loop does.
 */
import { vi } from 'vitest';
import { CameraRig, FRAME_MS, MAX_FRAME_DT_MS } from '../camera-rig.js';
import { clamp } from '../camera-math.js';
import { resolveViewerOptions } from '../defaults.js';
import type { ViewerOptions } from '../types.js';

/** A CameraRig, with its private state opened up for tests. */
export type RigInternals = {
  view: { yaw: number; pitch: number; fov: number };
  target: { yaw: number; pitch: number; fov: number };
  momentum: { yaw: number; pitch: number };
  glideFriction: number;
  panByPixels: (dx: number, dy: number) => void;
  flick: (vx: number, vy: number) => void;
  stopMomentum: () => void;
};
export const rigInternals = (rig: CameraRig) => rig as unknown as RigInternals;

/**
 * A rig for a `width` × `height` container. Its pointer coordinates are
 * pixels on a canvas of that size at the page origin.
 */
export function makeRig(
  width: number,
  height: number,
  options: Pick<ViewerOptions, 'camera' | 'autoRotate' | 'initialView'> = {},
): { rig: CameraRig; invalidate: ReturnType<typeof vi.fn> } {
  const opts = resolveViewerOptions(options);
  const invalidate = vi.fn();
  const ndc = { x: 0, y: 0 };
  const rig = new CameraRig(
    opts.camera,
    opts.autoRotate,
    options.initialView,
    invalidate,
    (x, y) => {
      ndc.x = (x / width) * 2 - 1;
      ndc.y = -((y / height) * 2 - 1);
      return ndc;
    },
  );
  rig.setViewport(width, height);
  return { rig, invalidate };
}

/**
 * Steps `rig` at frame times, with the dt PanoViewer's loop gives it: one
 * nominal 60 Hz frame for the first, then the time since the last one,
 * capped like a stalled frame. Returns step()'s result: still moving.
 */
export function frameClock(rig: CameraRig): (t: number) => boolean {
  let last: number | undefined;
  return (t) => {
    const dt = last === undefined ? FRAME_MS : clamp(t - last, 0, MAX_FRAME_DT_MS);
    last = t;
    return rig.step(t, dt);
  };
}
