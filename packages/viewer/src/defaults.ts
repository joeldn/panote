import type { View, WheelMode } from './types.js';

/**
 * Every ViewerOptions default, in one place. The viewer reads its defaults
 * from here and nowhere else, so a host can see what it gets by leaving an
 * option out, and a change to a default is one edit.
 *
 * Not here: `textureBudgetMB`, whose default depends on the display (see
 * `defaultTextureBudgetMB` in texture-budget.ts), and `initialView.yaw` and
 * `.pitch`, which start at 0.
 */
export interface ViewerDefaults {
  readonly baseUrl: string;
  /** Vertical fov limits, degrees. */
  readonly minFov: number;
  readonly maxFov: number;
  /** Caps the horizontal fov so wide screens don't over-stretch, degrees. */
  readonly maxHorizontalFov: number;
  /** Vertical fov of a camera whose view leaves fov unset, degrees. Clamped to the limits. */
  readonly fov: View['fov'];
  /** Easing toward the target per 16.67 ms; 1 snaps. */
  readonly damping: number;
  /** Release inertia kept per 16.67 ms. */
  readonly momentumFriction: number;
  readonly maxPixelRatio: number;
  readonly antialias: boolean;
  readonly maxConcurrent: number;
  readonly transitionMs: number;
  /** Compass north offset, radians. */
  readonly north: number;
  readonly autoRotate: boolean;
  /** Radians of yaw per second. */
  readonly autoRotateSpeed: number;
  readonly autoRotateIdleMs: number;
  readonly wheel: WheelMode;
}

export const VIEWER_DEFAULTS: ViewerDefaults = Object.freeze({
  baseUrl: '/tiles/',
  minFov: 15,
  maxFov: 80,
  maxHorizontalFov: 100,
  fov: 70,
  damping: 0.25,
  momentumFriction: 0.9,
  maxPixelRatio: 2,
  antialias: false,
  maxConcurrent: 8,
  transitionMs: 400,
  north: 0,
  autoRotate: false,
  autoRotateSpeed: 0.036,
  autoRotateIdleMs: 3000,
  wheel: 'always',
});
