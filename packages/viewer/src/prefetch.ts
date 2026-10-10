import { FACES, manifestUrl, parseManifest, tilePath } from '@panote/core';

export interface PrefetchOptions {
  /** Aborting cancels every request still in flight. */
  signal?: AbortSignal;
}

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

/**
 * Warm the HTTP cache for a pano the visitor may open next: its manifest and
 * the six level-0 tiles that `PanoViewer.load` blocks on. Requests go out at
 * low priority and the bodies are read and dropped, so a later load finds them
 * in the cache. Skipped under save-data or on 2g. Best effort: it never
 * rejects, whether the pano is missing, the network fails or `signal` aborts.
 */
export async function prefetchPano(
  baseUrl: string,
  pano: string,
  { signal }: PrefetchOptions = {},
): Promise<void> {
  if (signal?.aborted || !prefetchAllowed()) return;
  const init: RequestInit = { priority: 'low', ...(signal && { signal }) };
  try {
    const res = await fetch(manifestUrl(baseUrl, pano), init);
    if (!res.ok) return;
    const m = parseManifest(await res.json());
    await Promise.allSettled(
      FACES.map(async (face) => {
        const url = tilePath(baseUrl, m.pano, 0, face, 0, 0, m.format, m.version);
        const tile = await fetch(url, init);
        if (tile.ok) await tile.arrayBuffer();
      }),
    );
  } catch {
    // Best effort: the real load reports its own errors.
  }
}
