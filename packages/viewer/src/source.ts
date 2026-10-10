import { FACES, type Face } from './cube.js';
import type { TileImage } from './render/gl-renderer.js';

/** One tile of a cube pyramid. Level L has 2^L × 2^L tiles per face; x and y count from the top left. */
export interface TileAddress {
  face: Face;
  level: number;
  x: number;
  y: number;
}

/**
 * Where a panorama's tiles come from. The viewer knows nothing about URLs or
 * manifests: a host hands it one of these, directly or through
 * `ViewerOptions.resolveSource`.
 *
 * The pyramid: every face is the same square, split into `2^level` ×
 * `2^level` tiles of `tileSize` px at each level from 0 to `maxLevel`. Level 0
 * (one tile per face) is required: the viewer loads it before a scene goes on
 * screen, so every direction has a texture.
 *
 * Faces follow the viewer's cube convention (see cube.ts): ids `px nx py ny
 * pz nz`, u left to right and v top to bottom in image space, yaw 0 looking at
 * the centre of `nz`. Images are upright: their first row is the top of the
 * tile.
 */
export interface CubeTileSource {
  /** Stable id: the payload of 'loading', 'scene-change' and 'load-error', and used in errors. */
  readonly id: string;
  /** Edge of every tile at every level, px. */
  readonly tileSize: number;
  /** Finest level, 0 to MAX_SOURCE_LEVEL. */
  readonly maxLevel: number;
  /** Opaque content version; `showPreview`'s `replacesVersion` is compared against it ('' when absent). */
  readonly version?: string | undefined;
  /**
   * URL of one tile, fetched with the viewer's fetch and `requestInit` and
   * decoded with `createImageBitmap`. Ignored when `loadTile` is set.
   */
  tileUrl?(tile: TileAddress): string;
  /**
   * Full control over one tile: fetch, decode, auth, a worker, a canvas.
   * Must reject with an AbortError once `signal` aborts. Reject with a
   * `TileHttpError` to get the transient or permanent retry classification;
   * anything else counts as transient.
   */
  loadTile?(tile: TileAddress, signal: AbortSignal): Promise<TileImage>;
  /**
   * Reserved: px of neighbour gutter on every tile edge. Not supported yet;
   * a source that sets it to anything but 0 is refused.
   */
  readonly tileBorder?: number | undefined;
  /** Host data, passed through untouched (and handed back in 'ready'). */
  readonly meta?: unknown;
}

/** Hints for a resolver; it may ignore them. */
export interface ResolveHints {
  /** 'low' for a prefetch, unset for a load the visitor is waiting on. */
  priority?: RequestPriority;
}

/**
 * Turns an id given to `load()`, `transitionTo()` or `prefetch()` into a
 * source. Must reject with an AbortError once `signal` aborts.
 */
export type SourceResolver = (
  id: string,
  signal: AbortSignal,
  hints?: ResolveHints,
) => Promise<CubeTileSource>;

/**
 * Deepest pyramid a source may have. The per-level cull tables grow as 4^level
 * (level 10 is 6.3 M tiles), so a typo'd maxLevel must fail fast rather than
 * allocate gigabytes.
 */
export const MAX_SOURCE_LEVEL = 10;

/** Throws a TypeError naming what is wrong with `source`. */
export function assertSource(source: CubeTileSource): void {
  const fail = (what: string): never => {
    throw new TypeError(`tile source "${String(source.id)}": ${what}`);
  };
  if (typeof source.id !== 'string' || source.id === '') fail('id must be a non-empty string');
  if (!Number.isInteger(source.tileSize) || source.tileSize <= 0)
    fail('tileSize must be a positive integer');
  if (!Number.isInteger(source.maxLevel) || source.maxLevel < 0)
    fail('maxLevel must be a non-negative integer');
  if (source.maxLevel > MAX_SOURCE_LEVEL) fail(`maxLevel must be <= ${MAX_SOURCE_LEVEL}`);
  if (typeof source.loadTile !== 'function' && typeof source.tileUrl !== 'function')
    fail('needs tileUrl or loadTile');
  if ((source.tileBorder ?? 0) !== 0) fail('tileBorder is not supported yet');
}

export interface UrlTemplateInit {
  id: string;
  /**
   * A tile URL with `{level}`, `{face}`, `{x}` and `{y}` in it, e.g.
   * `'https://cdn.example/p1/{level}/{face}/{x}-{y}.jpg'`. Substituted as
   * given, not URL-encoded.
   */
  template: string;
  tileSize: number;
  maxLevel: number;
  /** What `{face}` becomes for each face; unmapped faces use their own id. */
  faceNames?: Partial<Record<Face, string>>;
  version?: string;
  meta?: unknown;
}

const PLACEHOLDERS = ['{level}', '{face}', '{x}', '{y}'] as const;

/** A source for the common static layout: one URL template for every tile. */
export function urlTemplateSource(init: UrlTemplateInit): CubeTileSource {
  const { id, template, tileSize, maxLevel, faceNames = {}, version, meta } = init;
  for (const p of PLACEHOLDERS) {
    if (!template.includes(p)) throw new TypeError(`urlTemplateSource: template has no ${p}`);
  }
  const names = Object.fromEntries(FACES.map((f) => [f, faceNames[f] ?? f])) as Record<
    Face,
    string
  >;
  const source: CubeTileSource = {
    id,
    tileSize,
    maxLevel,
    ...(version !== undefined && { version }),
    ...(meta !== undefined && { meta }),
    tileUrl: (t) =>
      template.replace(/\{(level|face|x|y)\}/g, (_, k: string) =>
        k === 'face' ? names[t.face] : String(t[k as 'level' | 'x' | 'y']),
      ),
  };
  assertSource(source);
  return source;
}
