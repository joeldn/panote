import type { CubeTileSource, SourceResolver, TileImage } from './source.js';

export interface View {
  yaw: number; // radians, around +y
  pitch: number; // radians, [-π/2, π/2]
  fov: number; // vertical fov in degrees
}

/** A direction on screen, from `PanoViewer.project()`. */
export interface ProjectedPoint {
  /** CSS px from the container's left. */
  x: number;
  /** CSS px from the container's top. */
  y: number;
  /** The direction is behind the camera; `x` and `y` mean nothing then. */
  behind: boolean;
}

/**
 * When the wheel drives the viewer.
 * - `'always'`: every wheel event zooms (or pans) and never scrolls the page.
 * - `'engaged'`: for embeds. A plain wheel scrolls the host page until the
 *   viewer is engaged; ctrl/cmd + wheel (and a trackpad pinch) always zooms.
 *   A pointerdown or focus engages; a mouse leaving or blur disengages.
 * - `'off'`: the viewer ignores the wheel, so it always scrolls (or, with
 *   ctrl, zooms) the page.
 */
export type WheelMode = 'always' | 'engaged' | 'off';

// Every default lives in defaults.ts (VIEWER_DEFAULTS); the notes here only
// say what each option means. Every field at every depth is optional.
export interface ViewerOptions {
  /**
   * Turns the ids given to load() and prefetch() into tile sources. Needed
   * only by a host that passes ids rather than sources.
   */
  resolveSource?: SourceResolver | undefined;
  /** The camera before the first load. Unset axes take the defaults. */
  initialView?: Partial<View> | undefined;
  camera?: CameraOptions | undefined;
  interaction?: InteractionOptions | undefined;
  rendering?: RenderingOptions | undefined;
  network?: NetworkOptions | undefined;
  memory?: MemoryOptions | undefined;
  transition?: TransitionOptions | undefined;
  /** Slow idle panning; `true`/`false` is shorthand for `{ enabled }`. */
  autoRotate?: boolean | AutoRotateOptions | undefined;
}

export interface CameraOptions {
  /** Vertical fov limits, degrees. */
  minFov?: number | undefined;
  maxFov?: number | undefined;
  /** Vertical fov of a camera whose view leaves fov unset, degrees. Clamped to the limits. */
  defaultFov?: number | undefined;
  /** Caps the horizontal fov so wide screens don't over-stretch, degrees. */
  maxHorizontalFov?: number | undefined;
  /** Pitch limits, radians. Keep them inside ±π/2: past it the view mirrors. */
  minPitch?: number | undefined;
  maxPitch?: number | undefined;
  /** 0..1: easing toward the target per 60 Hz frame (16.67 ms); 1 snaps. */
  damping?: number | undefined;
  /** 0..1: release inertia kept per 60 Hz frame; higher glides longer. */
  momentumFriction?: number | undefined;
  /** Compass north offset, radians. Change it at runtime with `setNorth()`. */
  north?: number | undefined;
}

export interface InteractionOptions {
  /** False builds no input handling at all: the camera moves only through the API. */
  enabled?: boolean | undefined;
  /** The canvas's accessible name (aria-label). Change it at runtime with `setLabel()`. */
  label?: string | undefined;
  /** Give the canvas `role="application"` and the label. */
  a11y?: boolean;
  /** Show the grab / grabbing cursor over the canvas. */
  cursor?: boolean | undefined;
  wheel?: WheelMode | undefined;
  /** ln(fov scale) per normalised wheel pixel. */
  wheelGain?: number | undefined;
  /** The same for a trackpad pinch (a ctrl-wheel with small pixel deltas). */
  pinchGain?: number | undefined;
  /**
   * Arrow keys pan by `panStepPx` (screen px), +/- zoom the fov by `zoomStep`
   * and its inverse. False ignores keys and leaves the canvas out of the tab order.
   */
  keyboard?: false | KeyboardOptions | undefined;
  /** Fov factor a double click zooms by, toward the point; false ignores double clicks. */
  doubleClickZoom?: number | false | undefined;
  /** Keep gliding after a fling. */
  inertia?: boolean | undefined;
}

export interface KeyboardOptions {
  panStepPx?: number | undefined;
  zoomStep?: number | undefined;
}

export interface RenderingOptions {
  /** Cap on devicePixelRatio. */
  maxPixelRatio?: number | undefined;
  /**
   * Cap on the canvas backbuffer, in device pixels. On a screen that would
   * exceed it the pixel ratio drops below maxPixelRatio, which also selects a
   * coarser tile level.
   */
  maxPixels?: number | undefined;
  antialias?: boolean | undefined;
  /** Anisotropic filtering of tiles: a sample count, or the device's maximum. */
  anisotropy?: number | 'max' | undefined;
  /** Clear colour, 0..1 per channel: what shows where no tile has loaded. */
  background?: readonly [r: number, g: number, b: number] | undefined;
  /**
   * Levels to shift tile selection by: positive picks coarser tiles (less
   * bandwidth, softer), negative finer ones. Added to the viewer's own
   * tolerance, so 0 is the viewer's normal choice.
   */
  lodBias?: number | undefined;
}

export interface NetworkOptions {
  /** Most tile requests in flight at once. */
  maxConcurrent?: number | undefined;
  /** The fetch tile requests go out through; the global fetch when unset. */
  fetch?: typeof fetch | undefined;
  /**
   * Spread into every tile request (mode, credentials, headers, cache). The
   * viewer sets signal and priority itself.
   */
  requestInit?: Omit<RequestInit, 'signal' | 'priority'> | undefined;
  /** Turns a fetched tile into an image; `createImageBitmap(blob)` when unset. */
  decode?: ((blob: Blob) => Promise<TileImage>) | undefined;
  /** Per-tile retries of a transient failure: attempts in all, and the first wait (doubling). */
  retry?: RetryOptions | undefined;
}

export interface RetryOptions {
  maxAttempts?: number | undefined;
  baseDelayMs?: number | undefined;
}

export interface MemoryOptions {
  /**
   * Resident tile textures, in MB of VRAM. `'auto'` is 128 on a
   * devicePixelRatio-1 display, scaled linearly with the ratio the viewer
   * renders at and capped at 2x (256): a finer display selects a finer
   * level and so needs more tiles resident to pan without re-decoding them.
   * On a phone-class device (a touch-first small screen, or 4 GB of memory
   * or less) it stays at 128. A number is used as given, unscaled and
   * uncapped.
   */
  textureBudgetMB?: number | 'auto' | undefined;
  /** Fewest tiles kept resident, however small the budget. */
  minResidentTiles?: number | undefined;
}

export interface TransitionOptions {
  /** The crossfade of a `load()` with `transition`, ms. */
  durationMs?: number | undefined;
  /** Cut instead of crossfading for a visitor who prefers reduced motion. */
  respectReducedMotion?: boolean | undefined;
}

export interface AutoRotateOptions {
  enabled?: boolean | undefined;
  /** Radians of yaw per second. */
  speed?: number | undefined;
  /** Interaction-free time before auto-rotate (re)starts, ms. */
  idleMs?: number | undefined;
}

/** `T` with every field set: required, read-only, and never undefined. */
type Resolved<T> = { readonly [K in keyof T]-?: Exclude<T[K], undefined> };

/** Recursively required and read-only: ViewerOptions with every default filled in. */
export interface ResolvedViewerOptions {
  readonly camera: Resolved<CameraOptions>;
  readonly interaction: Resolved<Omit<InteractionOptions, 'keyboard'>> & {
    readonly keyboard: false | Resolved<KeyboardOptions>;
  };
  readonly rendering: Resolved<RenderingOptions>;
  readonly network: Resolved<Omit<NetworkOptions, 'fetch' | 'decode' | 'retry'>> & {
    readonly retry: Resolved<RetryOptions>;
  };
  readonly memory: Resolved<MemoryOptions>;
  readonly transition: Resolved<TransitionOptions>;
  readonly autoRotate: Resolved<AutoRotateOptions>;
}

/**
 * Every event and its payload, for `PanoViewer.on()`. A type, not an
 * interface: the emitter needs an index signature (`Record<string, unknown>`),
 * which only a type alias gets implicitly. Payloads with data are objects, so
 * fields can be added without breaking listeners.
 */
export type PanoViewerEvents = {
  /** A load is starting for the source `id`. */
  loading: { id: string };
  /**
   * A load put `source` on screen (its base is resident). A host reads its own
   * data from `source.meta`.
   */
  ready: { id: string; source: CubeTileSource };
  /**
   * The scene `id` went on screen: its tiles from a `load()` (`kind: 'tiles'`,
   * right after `ready`) or a `showPreview()` (`kind: 'preview'`).
   */
  'scene-change': { id: string; kind: 'tiles' | 'preview' };
  /** Every tile the view needs is in. Also see `isSettled()`. */
  'tiles-settled': undefined;
  /**
   * The WebGL context was lost (GPU reset, memory pressure, a backgrounded
   * mobile tab). Nothing draws until it is restored.
   */
  'context-lost': undefined;
  /**
   * The context is back. The scene on screen (or the load that was in
   * flight) is loaded again by the viewer; a preview is not, since its pixels
   * were released once uploaded.
   */
  'context-restored': undefined;
  /**
   * A load the viewer started on its own (the reload after a context restore)
   * failed. `id` is the source it was loading. Loads the host starts reject
   * their own promise instead.
   */
  'load-error': { id: string; error: unknown };
};

export interface LoadOptions {
  /**
   * Camera for the incoming scene, applied when it swaps in rather than eased
   * to from the outgoing scene's camera. Unset axes keep their current value.
   */
  view?: Partial<View> | undefined;
  /**
   * Crossfade from a snapshot of the old scene, taken at the swap, rather
   * than cut. The load's promise settles once the fade is over.
   */
  transition?: boolean | undefined;
}

export interface ShowPreviewOptions {
  /**
   * For a replace: the `version` of the source the preview replaces (`''`
   * for one without). Leave it out for a new scene.
   */
  replacesVersion?: string | undefined;
  /**
   * Camera for the preview, cut to as it goes up (like `LoadOptions.view`),
   * not eased to. Unset axes keep their current value.
   */
  view?: Partial<View> | undefined;
}

export interface PrefetchOptions {
  /** Aborting cancels the resolve and every request still in flight. */
  signal?: AbortSignal | undefined;
}
