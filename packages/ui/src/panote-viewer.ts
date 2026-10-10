import { manifestUrl, parseManifest, tilePath, type Manifest } from '@panote/core';
import type { CubeTileSource, PanoViewer, SourceResolver, ViewerOptions } from '@panote/viewer';

/**
 * panote's side of `@panote/viewer`: where panote keeps its tiles and how its
 * manifests read. The viewer itself knows neither; PanoStage builds it with
 * `panoteViewerPreset`.
 */

/**
 * Every panote viewer request (manifests and tiles) goes out as a plain CORS
 * fetch: mode 'cors', credentials 'same-origin', which is what a bare
 * `fetch(url)` does. The website Worker preloads the manifest and the six
 * level-0 tiles with `<link rel=preload as=fetch crossorigin>`, and a preload
 * is only reused by a request with the same URL, mode and credentials, so
 * this must not change without changing those preloads too
 * (apps/website/worker/boot.ts).
 */
export const PANOTE_REQUEST_INIT: Readonly<Pick<RequestInit, 'mode' | 'credentials'>> =
  Object.freeze({ mode: 'cors', credentials: 'same-origin' });

/** The tile source for a parsed manifest, with tiles under `baseUrl` in panote's layout. */
export function panoteSource(baseUrl: string, m: Manifest): CubeTileSource {
  return {
    id: m.pano,
    tileSize: m.tileSize,
    maxLevel: m.maxLevel,
    version: m.version,
    // core's tilePath, byte for byte: the URLs must equal the Worker's preloads.
    tileUrl: (t) => tilePath(baseUrl, m.pano, t.level, t.face, t.x, t.y, m.format, m.version),
    meta: m,
  };
}

/** Drop an error response's body unread, so its connection is freed rather than held. */
function discard(res: Response): void {
  res.body?.cancel().catch(() => {});
}

/**
 * Resolves a pano id to its source: fetches `<baseUrl><pano>/manifest.json`
 * and parses it. Rejects with `manifest <status>` for a response that is not
 * ok, and with the AbortError once `signal` aborts.
 */
export function panoteSourceResolver(baseUrl: string): SourceResolver {
  return async (id, signal, hints) => {
    const res = await fetch(manifestUrl(baseUrl, id), {
      ...PANOTE_REQUEST_INIT,
      signal,
      ...(hints?.priority && { priority: hints.priority }),
    });
    if (!res.ok) {
      discard(res);
      throw new Error(`manifest ${res.status}`);
    }
    const json: unknown = await res.json();
    return panoteSource(baseUrl, parseManifest(json));
  };
}

export interface PanoteViewerPresetOptions {
  /** Tiles base, e.g. `tilesBaseUrl(config)`. */
  baseUrl: string;
}

/**
 * The viewer options panote needs on top of the viewer's defaults: the
 * manifest resolver and the request init the Worker's preloads match.
 */
export function panoteViewerPreset({ baseUrl }: PanoteViewerPresetOptions): ViewerOptions {
  return {
    resolveSource: panoteSourceResolver(baseUrl),
    requestInit: PANOTE_REQUEST_INIT,
  };
}

/** The manifest behind a source built here; undefined for any other source. */
export const manifestOf = (source: CubeTileSource): Manifest | undefined =>
  source.meta as Manifest | undefined;

// The parts of the Network Information API read here; not in every browser
// (or in TypeScript's DOM lib), so it is read defensively.
interface ConnectionHint {
  saveData?: boolean;
  effectiveType?: string;
}

/** False when the visitor asked to save data or is on a 2g-class connection. */
function prefetchAllowed(): boolean {
  const nav = (globalThis as { navigator?: { connection?: ConnectionHint } }).navigator;
  const c = nav?.connection;
  if (!c) return true;
  return c.saveData !== true && c.effectiveType !== '2g' && c.effectiveType !== 'slow-2g';
}

export interface PrefetchPanoOptions {
  /** Aborting cancels every request still in flight. */
  signal?: AbortSignal;
}

/**
 * Warm the cache for a pano the visitor may open next (see
 * `PanoViewer.prefetch`), unless they asked to save data or are on 2g. Best
 * effort: never rejects.
 */
export async function prefetchPano(
  viewer: PanoViewer,
  pano: string,
  { signal }: PrefetchPanoOptions = {},
): Promise<void> {
  if (signal?.aborted || !prefetchAllowed()) return;
  await viewer.prefetch(pano, signal ? { signal } : {});
}
