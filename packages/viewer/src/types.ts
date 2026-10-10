import type { CubeTileSource, SourceResolver } from './source.js';

export interface View {
  yaw: number; // radians, around +y
  pitch: number; // radians, [-π/2, π/2]
  fov: number; // vertical fov in degrees
}

/**
 * When the wheel drives the viewer.
 * - `'always'`: every wheel event zooms (or pans) and never scrolls the page.
 * - `'engaged'`: for embeds. A plain wheel scrolls the host page until the
 *   viewer is engaged; ctrl/cmd + wheel (and a trackpad pinch) always zooms.
 *   A pointerdown or focus engages; a mouse leaving or blur disengages.
 */
export type WheelMode = 'always' | 'engaged';

// Every default lives in defaults.ts (VIEWER_DEFAULTS); the notes here only
// say what each option means.
export interface ViewerOptions {
  // Turns the ids given to load(), transitionTo() and prefetch() into tile
  // sources. Needed only by a host that passes ids rather than sources.
  resolveSource?: SourceResolver;
  // The fetch tile requests go out through; the global fetch when unset.
  fetch?: typeof fetch;
  // Spread into every tile request (mode, credentials, headers, cache). The
  // viewer sets signal and priority itself.
  requestInit?: Omit<RequestInit, 'signal' | 'priority'>;
  minFov?: number; // vertical, degrees
  maxFov?: number; // vertical, degrees
  maxHorizontalFov?: number; // degrees; caps horizontal fov so wide screens don't over-stretch
  // Resident tile textures, in MB of base-level RGBA. Defaults to 128 on a
  // devicePixelRatio-1 display and scales linearly with the ratio the viewer
  // renders at, capped at 2x (256) — a finer display selects a finer pyramid
  // level and so needs more tiles resident to pan without re-decoding them.
  // An explicit value is absolute: it is used as given, unscaled and uncapped.
  textureBudgetMB?: number;
  initialView?: Partial<View>; // unset axes take the defaults
  damping?: number; // 0..1 camera easing toward target per 60 Hz frame (16.67 ms); 1 = instant
  momentumFriction?: number; // 0..1 decay of release inertia per 60 Hz frame; higher = longer glide
  maxPixelRatio?: number; // cap on devicePixelRatio
  // Cap on the canvas backbuffer, in device pixels. On a screen that would
  // exceed it the pixel ratio drops below maxPixelRatio, which also selects a
  // coarser tile level.
  maxPixels?: number;
  antialias?: boolean;
  maxConcurrent?: number; // max simultaneous tile requests
  transitionMs?: number; // crossfade duration in ms
  north?: number; // radians offset defining compass north for the loaded scene
  autoRotate?: boolean; // slowly pan when idle
  autoRotateSpeed?: number; // radians of yaw per second while rotating
  autoRotateIdleMs?: number; // interaction-free time before auto-rotate (re)starts
  wheel?: WheelMode; // wheel capture; 'engaged' leaves page scroll alone until the viewer is used
}

export type PanoViewerEvents = {
  // The source a load() put on screen; a host reads its own data from `meta`.
  ready: CubeTileSource;
  'tiles-settled': undefined;
  loading: string; // source id
  'scene-change': string; // source id, emitted whenever a load() or showPreview() completes
  'hotspot-open': string; // hotspotId, reported by a hotspot UI layer
  // The WebGL context was lost (GPU reset, memory pressure, a backgrounded
  // mobile tab). Nothing draws until it is restored.
  'context-lost': undefined;
  // The context is back. The scene on screen (or the load that was in flight)
  // is loaded again by the viewer; a preview is not, since its pixels were
  // released once uploaded.
  'context-restored': undefined;
  // A load the viewer started on its own (the reload after a context restore)
  // failed. `id` is the source it was loading. Loads the host starts reject
  // their own promise instead.
  'load-error': { error: unknown; id: string };
};

export interface LoadOptions {
  // Camera for the incoming scene, applied when it swaps in rather than eased
  // to from the outgoing scene's camera. Unset axes keep their current value.
  view?: Partial<View>;
}

export interface PrefetchOptions {
  // Aborting cancels the resolve and every request still in flight.
  signal?: AbortSignal;
}
