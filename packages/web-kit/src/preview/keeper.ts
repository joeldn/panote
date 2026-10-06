import { decodePreview, type DecodePreviewOptions } from './client.js';
import { closePreview, type DecodedPreview } from './decode.js';
import type { PreviewSource, PreviewTier } from './plan.js';

/** `decodePreview`'s shape, so callers (and tests) can swap the worker out. */
export type PreviewDecoder = (
  file: Blob,
  options: DecodePreviewOptions,
) => Promise<DecodedPreview | null>;

export interface KeepPreviewOptions {
  /** Defaults to the tier the device hints pick. */
  tier?: PreviewTier | undefined;
  /** WebGL `MAX_TEXTURE_SIZE`, e.g. from `probeMaxTextureSize()`. */
  maxTextureSize?: number | undefined;
  decode?: PreviewDecoder | undefined;
}

/**
 * One picked file's preview, for as long as its upload needs it. The viewer
 * closes the bitmaps it is given, so each `next()` hands out a source nobody
 * else holds: the first decode (full tier) once, then a decode of the small
 * stash image (or of the file again, if no stash could be encoded).
 */
export interface PreviewKeeper {
  /** Settles once the first decode is done, never rejects: whether there is a preview. */
  readonly ready: Promise<boolean>;
  /** The first decode produced a preview, and the keeper isn't disposed. */
  readonly available: boolean;
  /** A fresh source; rejects when there is no preview (or no longer one). */
  next(): Promise<PreviewSource>;
  /** Closes the first decode if it's still unshown; a later `next()` decodes the stash. */
  release(): void;
  /** Aborts any decode and frees what is held; `next()` rejects from then on. */
  dispose(): void;
}

const noPreview = () => new Error('No preview for this upload.');

/** Decode `file` now, off the main thread, and keep what's needed to show it again. */
export function keepPreview(file: Blob, options: KeepPreviewOptions = {}): PreviewKeeper {
  const decode = options.decode ?? decodePreview;
  const abort = new AbortController();
  const base: DecodePreviewOptions = {
    signal: abort.signal,
    tier: options.tier,
    maxTextureSize: options.maxTextureSize,
  };
  let held: PreviewSource | null = null;
  let stash: Blob | null = null;
  let ok = false;
  let disposed = false;

  // A decode failure only means no preview: the upload never hears about it.
  const ready = (async () => {
    try {
      const out = await decode(file, base);
      if (!out) return false;
      if (disposed) {
        closePreview(out.source);
        return false;
      }
      held = out.source;
      stash = out.stash;
      ok = true;
      return true;
    } catch {
      return false;
    }
  })();

  return {
    ready,
    get available() {
      return ok && !disposed;
    },
    async next() {
      if (!(await ready) || disposed) throw noPreview();
      if (held) {
        const first = held;
        held = null;
        return first;
      }
      const out = await decode(stash ?? file, { ...base, stash: false });
      if (!out) throw noPreview();
      if (disposed) {
        closePreview(out.source);
        throw noPreview();
      }
      return out.source;
    },
    release() {
      if (held) closePreview(held);
      held = null;
    },
    dispose() {
      disposed = true;
      abort.abort();
      if (held) closePreview(held);
      held = null;
      stash = null;
    },
  };
}

interface WebGlProbeCanvas {
  getContext(
    type: 'webgl2',
  ): Pick<WebGL2RenderingContext, 'getParameter' | 'getExtension' | 'MAX_TEXTURE_SIZE'> | null;
}

/** `MAX_TEXTURE_SIZE` of a throwaway WebGL2 context; undefined where there is none. */
export function readMaxTextureSize(createCanvas: () => WebGlProbeCanvas): number | undefined {
  try {
    const gl = createCanvas().getContext('webgl2');
    if (!gl) return undefined;
    const size = gl.getParameter(gl.MAX_TEXTURE_SIZE) as unknown;
    // Hand the context back now rather than at GC: browsers cap live contexts.
    (gl.getExtension('WEBGL_lose_context') as WEBGL_lose_context | null)?.loseContext();
    return typeof size === 'number' && size > 0 ? size : undefined;
  } catch {
    return undefined;
  }
}

let probed: { size: number | undefined } | null = null;

/** This device's `MAX_TEXTURE_SIZE`, probed once per page. Undefined without WebGL2. */
export function probeMaxTextureSize(): number | undefined {
  if (!probed) {
    const usable = typeof document !== 'undefined' && typeof WebGL2RenderingContext !== 'undefined';
    probed = {
      size: usable
        ? readMaxTextureSize(() => document.createElement('canvas') as WebGlProbeCanvas)
        : undefined,
    };
  }
  return probed.size;
}
