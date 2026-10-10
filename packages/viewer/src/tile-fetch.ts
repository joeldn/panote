import type { TileImage } from './render/gl-renderer.js';
import type { CubeTileSource, TileAddress } from './source.js';
import { TileHttpError } from './tile-retry.js';

/** How tile requests go out; from ViewerOptions. */
export interface TileNetwork {
  /** Defaults to the global fetch, looked up per request. */
  fetch?: typeof fetch | undefined;
  /** Spread into every tile request, under the viewer's own signal and priority. */
  requestInit?: RequestInit | undefined;
}

/**
 * The one place a tile request goes out, for loads and prefetches alike, so
 * both carry the same init. A host that preloads tiles (a `<link
 * rel=preload crossorigin>`) depends on that: a preload is only reused by a
 * request with the same URL, mode and credentials.
 */
export function requestTile(
  net: TileNetwork,
  url: string,
  signal: AbortSignal,
  priority: RequestPriority,
): Promise<Response> {
  // Called unbound: a host's `window.fetch` called as `net.fetch(...)` would
  // throw an Illegal invocation.
  const f = net.fetch ?? globalThis.fetch;
  return f(url, { ...net.requestInit, signal, priority });
}

/** One tile, decoded: through the source's loadTile, or fetched from its tileUrl. */
export async function loadTileImage(
  source: CubeTileSource,
  tile: TileAddress,
  signal: AbortSignal,
  priority: RequestPriority,
  net: TileNetwork,
): Promise<TileImage> {
  if (source.loadTile) return source.loadTile(tile, signal);
  const res = await requestTile(net, source.tileUrl!(tile), signal, priority);
  if (!res.ok) throw new TileHttpError(res.status);
  const blob = await res.blob();
  // Decoded upright (row 0 = top). The renderer uploads it unflipped and the
  // tile UVs address row 0 as v = 0 (see tile-geometry.ts).
  return createImageBitmap(blob);
}

/** Drop an error response's body unread, so its connection is freed rather than held. */
export function discardBody(res: Response): void {
  res.body?.cancel().catch(() => {});
}

/**
 * Warm one tile for a later load: fetched at low priority and the body read
 * and dropped, so the load finds it in the HTTP cache. A `loadTile` source is
 * asked for the tile and the image released, for whatever cache it keeps.
 */
export async function warmTile(
  source: CubeTileSource,
  tile: TileAddress,
  signal: AbortSignal,
  net: TileNetwork,
): Promise<void> {
  if (source.loadTile) {
    releaseImage(await source.loadTile(tile, signal));
    return;
  }
  const res = await requestTile(net, source.tileUrl!(tile), signal, 'low');
  if (res.ok) await res.arrayBuffer();
  else discardBody(res);
}

/** Free an image's pixels now, where the type allows it (an ImageBitmap). */
export function releaseImage(image: TileImage): void {
  if ('close' in image && typeof image.close === 'function') image.close();
}
