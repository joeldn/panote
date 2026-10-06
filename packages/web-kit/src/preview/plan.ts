import type { ImageSize } from '../image-size.js';

/**
 * One drawable piece of a preview, in preview pixel coordinates. `image` covers
 * exactly the `x, y, w, h` rect. Structurally identical to the viewer's type.
 */
export interface PreviewPatch {
  x: number;
  y: number;
  w: number;
  h: number;
  image: ImageBitmap | HTMLCanvasElement | OffscreenCanvas;
}

/** A downscaled equirect split into patches. Mirrors `PreviewSource` in `@panote/viewer`. */
export interface PreviewSource {
  width: number;
  height: number;
  patches: PreviewPatch[];
}

export type PreviewTier = 'phone' | 'desktop';

/** Longest edges per tier: memory decides, not `MAX_TEXTURE_SIZE`. */
export const PREVIEW_TIERS: Readonly<Record<PreviewTier, ImageSize>> = {
  phone: { width: 4096, height: 2048 },
  desktop: { width: 8192, height: 4096 },
};

/** Largest patch edge, before `MAX_TEXTURE_SIZE` lowers it further. */
export const MAX_PATCH_SIZE = 4096;

/** Pixels each patch borrows from its neighbours, so filtering doesn't seam. */
export const PATCH_GUTTER = 2;

/** Above this, a phone without decode-time resize skips the preview. */
export const PHONE_FULL_DECODE_MAX_PIXELS = 50_000_000;

export interface DeviceHints {
  /** `navigator.deviceMemory` in GiB, where the browser exposes it. */
  deviceMemory?: number | undefined;
  /** `(pointer: coarse)` matches. */
  coarsePointer: boolean;
}

export function selectPreviewTier(hints: DeviceHints): PreviewTier {
  const lowMemory = hints.deviceMemory !== undefined && hints.deviceMemory <= 4;
  return lowMemory || hints.coarsePointer ? 'phone' : 'desktop';
}

interface HintSources {
  navigator?: { deviceMemory?: unknown } | undefined;
  matchMedia?: ((query: string) => { matches: boolean }) | undefined;
}

/** Read the tier hints on the main thread (workers have no `matchMedia`). */
export function readDeviceHints(
  from: HintSources = globalThis as unknown as HintSources,
): DeviceHints {
  const memory = from.navigator?.deviceMemory;
  return {
    deviceMemory: typeof memory === 'number' ? memory : undefined,
    coarsePointer: from.matchMedia?.('(pointer: coarse)').matches ?? false,
  };
}

export interface PreviewLimits {
  /** WebGL `MAX_TEXTURE_SIZE`; caps each patch edge. */
  maxTextureSize?: number | undefined;
  /** Extra cap on the preview width, from the caller. */
  maxWidth?: number | undefined;
}

/** Preview size for a source: the tier box, never upscaled, aspect kept. */
export function previewSize(
  source: ImageSize,
  tier: PreviewTier,
  limits: PreviewLimits = {},
): ImageSize {
  const box = PREVIEW_TIERS[tier];
  const maxWidth = Math.min(box.width, limits.maxWidth ?? Infinity);
  const scale = Math.min(1, maxWidth / source.width, box.height / source.height);
  if (scale === 1) return { width: source.width, height: source.height };
  return {
    width: Math.max(1, Math.round(source.width * scale)),
    height: Math.max(1, Math.round(source.height * scale)),
  };
}

export function patchLimit(limits: PreviewLimits = {}): number {
  return Math.max(1, Math.min(MAX_PATCH_SIZE, limits.maxTextureSize ?? MAX_PATCH_SIZE));
}

interface Span {
  start: number;
  size: number;
}

/** Split `[0, length)` into the fewest even spans whose gutters still fit `max`. */
function splitAxis(length: number, max: number, gutter: number): Span[] {
  let n = 1;
  // An interior span carries a gutter on both sides; edge spans only on one.
  const outer = (count: number) => Math.ceil(length / count) + Math.min(count - 1, 2) * gutter;
  while (outer(n) > max && n < length) n += 1;
  const cut = (i: number) => Math.round((i * length) / n);
  return Array.from({ length: n }, (_, i) => {
    const start = Math.max(0, cut(i) - gutter);
    const end = Math.min(length, cut(i + 1) + gutter);
    return { start, size: end - start };
  });
}

export type PatchRect = Omit<PreviewPatch, 'image'>;

/**
 * Cover a `width` x `height` image with patches no larger than `max` per edge.
 * Neighbours overlap by `2 * gutter`; image borders get no gutter.
 */
export function planPatches(
  width: number,
  height: number,
  max: number,
  gutter = PATCH_GUTTER,
): PatchRect[] {
  if (max <= 2 * gutter) throw new RangeError(`patch limit ${max} leaves no room for gutters`);
  const cols = splitAxis(width, max, gutter);
  const rows = splitAxis(height, max, gutter);
  return rows.flatMap((r) => cols.map((c) => ({ x: c.start, y: r.start, w: c.size, h: r.size })));
}
