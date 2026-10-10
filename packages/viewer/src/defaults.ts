import type { ResolvedViewerOptions, ViewerOptions } from './types.js';

/** Pitch limit either way: just short of straight up or down, where the view would mirror. */
const PITCH_LIMIT = Math.PI / 2 - 0.001;

/**
 * Every ViewerOptions default, in one place. The viewer reads its defaults
 * from here and nowhere else, so a host can see what it gets by leaving an
 * option out, and a change to a default is one edit. The README's options
 * table is checked against this object.
 *
 * Options without a default are not here: `resolveSource` (ids then
 * reject), `initialView` (yaw and pitch 0, fov `camera.defaultFov`),
 * `network.fetch` (the global fetch, looked up per request) and
 * `network.decode` (`createImageBitmap`).
 */
export const VIEWER_DEFAULTS = deepFreeze({
  camera: {
    minFov: 15,
    maxFov: 80,
    defaultFov: 70,
    maxHorizontalFov: 100,
    minPitch: -PITCH_LIMIT,
    maxPitch: PITCH_LIMIT,
    damping: 0.25,
    momentumFriction: 0.9,
    north: 0,
  },
  interaction: {
    enabled: true,
    label: 'Panorama viewer',
    a11y: true,
    cursor: true,
    wheel: 'always',
    // Chrome and Firefox report a trackpad pinch as a ctrl-wheel with small
    // pixel deltas (about 1-10), so that shape gets ten times the gain.
    wheelGain: 0.001,
    pinchGain: 0.01,
    keyboard: { panStepPx: 40, zoomStep: 0.8 },
    doubleClickZoom: 0.6,
    inertia: true,
  },
  rendering: {
    maxPixelRatio: 2,
    // One 4K frame. A phone or a laptop at its default scaling (a 14"
    // MacBook is 1512 × 982 at DPR 2, 5.9 Mpx) is under it, while a 5K
    // display at DPR 2 (14.7 Mpx) would otherwise fetch, decode and fill a
    // finer pyramid level for little visible gain.
    maxPixels: 8_300_000,
    antialias: false,
    anisotropy: 'max',
    background: [0, 0, 0],
    lodBias: 0,
  },
  network: {
    maxConcurrent: 8,
    // Nothing added: a plain fetch, so mode 'cors' and credentials 'same-origin'.
    requestInit: {},
    retry: { maxAttempts: 3, baseDelayMs: 1000 },
  },
  memory: {
    textureBudgetMB: 'auto',
    minResidentTiles: 24,
  },
  transition: {
    durationMs: 400,
    respectReducedMotion: true,
  },
  autoRotate: {
    enabled: false,
    speed: 0.036,
    idleMs: 3000,
  },
} as const satisfies ResolvedViewerOptions);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

function deepFreeze<T>(value: T): T {
  if (isPlainObject(value) || Array.isArray(value)) {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

/** `autoRotate: true` is shorthand for `{ enabled: true }`. */
function expandAutoRotate(options: ViewerOptions): ViewerOptions {
  return typeof options.autoRotate === 'boolean'
    ? { ...options, autoRotate: { enabled: options.autoRotate } }
    : options;
}

function mergeInto(base: unknown, layer: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(layer)) return layer;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(layer)) {
    if (value === undefined) continue;
    out[key] = mergeInto(out[key], value);
  }
  return out;
}

/**
 * Deep-merge option layers, later ones winning. Plain objects merge key by
 * key; anything else (a number, an array, a function, `false`, a Headers)
 * replaces what is under it, and `undefined` leaves it alone. Handy for a
 * preset with per-page overrides on top.
 */
export function mergeViewerOptions(...layers: readonly ViewerOptions[]): ViewerOptions {
  let out: unknown = {};
  for (const layer of layers) out = mergeInto(out, expandAutoRotate(layer));
  return out as ViewerOptions;
}

/** `options` over VIEWER_DEFAULTS: what a viewer built with them runs on. */
export function resolveViewerOptions(options: ViewerOptions = {}): ResolvedViewerOptions {
  // Only the options that have a default: the rest are read where used.
  const rest: ViewerOptions = { ...expandAutoRotate(options) };
  delete rest.resolveSource;
  delete rest.initialView;
  if (rest.network) {
    rest.network = { ...rest.network };
    delete rest.network.fetch;
    delete rest.network.decode;
  }
  return mergeInto(VIEWER_DEFAULTS, rest) as ResolvedViewerOptions;
}
