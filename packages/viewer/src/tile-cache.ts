/** What eviction reads of a cached tile. */
export interface EvictCandidate {
  key: string;
  /** Pyramid level; level 0 is never evicted. */
  level: number;
  /** The frame the tile was last drawn or needed in. */
  lastUsed: number;
}

/**
 * The `overflow` least recently used of `entries` that may go, oldest first,
 * written into `out`. Ties go in iteration order, as a stable sort would put
 * them.
 *
 * Level-0 tiles are the base layer (see TileLayer.loadBase) and never go.
 * Nor do tiles stamped with `currentFrame`: they are on screen right now, and
 * evicting one would only refetch it next frame and evict it again, forever,
 * with the camera standing still. So the cache can stay over budget, by at
 * most the visible set.
 *
 * A partial selection: one pass that keeps the oldest `overflow` seen so far
 * in order, so a cache a few tiles over budget costs a scan, not a sort of
 * every entry. Most entries are newer than the newest one kept and cost one
 * comparison.
 */
export function pickEvictions<T extends EvictCandidate>(
  entries: Iterable<T>,
  overflow: number,
  currentFrame: number | undefined,
  out: T[],
): T[] {
  out.length = 0;
  if (overflow <= 0) return out;
  for (const e of entries) {
    if (e.lastUsed === currentFrame || e.level === 0) continue;
    const t = e.lastUsed;
    let n = out.length;
    if (n === overflow) {
      // Not older than the newest kept: it would sort after it.
      if (t >= out[n - 1]!.lastUsed) continue;
      n--;
    } else {
      out.length = n + 1;
    }
    // Insert after every kept entry that is not newer: stable for ties.
    while (n > 0 && out[n - 1]!.lastUsed > t) {
      out[n] = out[n - 1]!;
      n--;
    }
    out[n] = e;
  }
  return out;
}
