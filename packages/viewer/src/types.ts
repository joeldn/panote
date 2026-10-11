import type { TileImage } from './render/gl-renderer.js';
import type { CubeTileSource, SourceResolver } from './source.js';

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
   * Turns the ids given to load(), transitionTo() and prefetch() into tile
   * sources. Needed only by a host that passes ids rather than sources.
   */
  resolveSource?: SourceResolver;
  /** The camera before the first load. Unset axes take the defaults. */
  initialView?: Partial<View>;
  camera?: CameraOptions;
  interaction?: InteractionOptions;
  rendering?: RenderingOptions;
  network?: NetworkOptions;
  memory?: MemoryOptions;
  transition?: TransitionOptions;
  /** Slow idle panning; `true`/`false` is shorthand for `{ enabled }`. */
  autoRotate?: boolean | AutoRotateOptions;
}

export interface CameraOptions {
  /** Vertical fov limits, degrees. */
  minFov?: number;
  maxFov?: number;
  /** Vertical fov of a camera whose view leaves fov unset, degrees. Clamped to the limits. */
  defaultFov?: number;
  /** Caps the horizontal fov so wide screens don't over-stretch, degrees. */
  maxHorizontalFov?: number;
  /** Pitch limits, radians. Keep them inside ±π/2: past it the view mirrors. */
  minPitch?: number;
  maxPitch?: number;
  /** 0..1: easing toward the target per 60 Hz frame (16.67 ms); 1 snaps. */
  damping?: number;
  /** 0..1: release inertia kept per 60 Hz frame; higher glides longer. */
  momentumFriction?: number;
  /** Compass north offset, radians. Change it at runtime with `setNorth()`. */
  north?: number;
}

export interface InteractionOptions {
  /** False builds no input handling at all: the camera moves only through the API. */
  enabled?: boolean;
  /** The canvas's accessible name (aria-label). Change it at runtime with `setLabel()`. */
  label?: string;
  /** Give the canvas `role="application"` and the label. */
  a11y?: boolean;
  /** Show the grab / grabbing cursor over the canvas. */
  cursor?: boolean;
  wheel?: WheelMode;
  /** ln(fov scale) per normalised wheel pixel. */
  wheelGain?: number;
  /** The same for a trackpad pinch (a ctrl-wheel with small pixel deltas). */
  pinchGain?: number;
  /**
   * Arrow keys pan by `panStepPx` (screen px), +/- zoom the fov by `zoomStep`
   * and its inverse. False ignores keys and leaves the canvas out of the tab order.
   */
  keyboard?: false | KeyboardOptions;
  /** Fov factor a double click zooms by, toward the point; false ignores double clicks. */
  doubleClickZoom?: number | false;
  /** Keep gliding after a fling. */
  inertia?: boolean;
}

export interface KeyboardOptions {
  panStepPx?: number;
  zoomStep?: number;
}

export interface RenderingOptions {
  /** Cap on devicePixelRatio. */
  maxPixelRatio?: number;
  /**
   * Cap on the canvas backbuffer, in device pixels. On a screen that would
   * exceed it the pixel ratio drops below maxPixelRatio, which also selects a
   * coarser tile level.
   */
  maxPixels?: number;
  antialias?: boolean;
  /** Anisotropic filtering of tiles: a sample count, or the device's maximum. */
  anisotropy?: number | 'max';
  /** Clear colour, 0..1 per channel: what shows where no tile has loaded. */
  background?: readonly [r: number, g: number, b: number];
  /**
   * Levels to shift tile selection by: positive picks coarser tiles (less
   * bandwidth, softer), negative finer ones. Added to the viewer's own
   * tolerance, so 0 is the viewer's normal choice.
   */
  lodBias?: number;
}

export interface NetworkOptions {
  /** Most tile requests in flight at once. */
  maxConcurrent?: number;
  /** The fetch tile requests go out through; the global fetch when unset. */
  fetch?: typeof fetch;
  /**
   * Spread into every tile request (mode, credentials, headers, cache). The
   * viewer sets signal and priority itself.
   */
  requestInit?: Omit<RequestInit, 'signal' | 'priority'>;
  /** Turns a fetched tile into an image; `createImageBitmap(blob)` when unset. */
  decode?: (blob: Blob) => Promise<TileImage>;
  /** Per-tile retries of a transient failure: attempts in all, and the first wait (doubling). */
  retry?: RetryOptions;
}

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
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
  textureBudgetMB?: number | 'auto';
  /** Fewest tiles kept resident, however small the budget. */
  minResidentTiles?: number;
}

export interface TransitionOptions {
  /** transitionTo()'s crossfade, ms. */
  durationMs?: number;
  /** Cut instead of crossfading for a visitor who prefers reduced motion. */
  respectReducedMotion?: boolean;
}

export interface AutoRotateOptions {
  enabled?: boolean;
  /** Radians of yaw per second. */
  speed?: number;
  /** Interaction-free time before auto-rotate (re)starts, ms. */
  idleMs?: number;
}

/** Recursively required and read-only: ViewerOptions with every default filled in. */
export interface ResolvedViewerOptions {
  readonly camera: Readonly<Required<CameraOptions>>;
  readonly interaction: Readonly<
    Required<Omit<InteractionOptions, 'keyboard'>> & {
      keyboard: false | Readonly<Required<KeyboardOptions>>;
    }
  >;
  readonly rendering: Readonly<Required<RenderingOptions>>;
  readonly network: Readonly<
    Required<Omit<NetworkOptions, 'fetch' | 'decode' | 'retry'>> & {
      retry: Readonly<Required<RetryOptions>>;
    }
  >;
  readonly memory: Readonly<Required<MemoryOptions>>;
  readonly transition: Readonly<Required<TransitionOptions>>;
  readonly autoRotate: Readonly<Required<AutoRotateOptions>>;
}

export type PanoViewerEvents = {
  // The source a load() put on screen; a host reads its own data from `meta`.
  ready: CubeTileSource;
  'tiles-settled': undefined;
  loading: string; // source id
  'scene-change': string; // source id, emitted whenever a load() or showPreview() completes
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

export interface ShowPreviewOptions {
  /**
   * For a replace: the `version` of the source the preview replaces (`''`
   * for one without). Leave it out for a new scene.
   */
  replacesVersion?: string;
  /**
   * Camera for the preview, cut to as it goes up (like `LoadOptions.view`),
   * not eased to. Unset axes keep their current value.
   */
  view?: Partial<View>;
}

export interface PrefetchOptions {
  // Aborting cancels the resolve and every request still in flight.
  signal?: AbortSignal;
}
