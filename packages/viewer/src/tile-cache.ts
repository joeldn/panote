export interface EvictCandidate {
  key: string;
  lastUsed: number;
}

/**
 * Choose which tile keys to evict when the cache exceeds maxTiles.
 * Level-0 tiles (keys starting with '0/') are the preview and are never evicted.
 * Evicts least-recently-used non-level-0 tiles first.
 *
 * Tiles stamped with `currentFrame` are on screen right now and are never
 * evicted either, even if that leaves the cache over budget. Evicting one
 * would only refetch it next frame and evict it again, forever, with the
 * camera standing still. The overshoot is bounded by the visible set.
 */
export function selectEvictions(
  entries: EvictCandidate[],
  maxTiles: number,
  currentFrame?: number,
): string[] {
  return pickEvictions(entries, entries.length - maxTiles, currentFrame, []).map((e) => e.key);
}

/**
 * The `overflow` least recently used of `entries` that may go (see
 * selectEvictions), oldest first, written into `out`. Ties go in iteration
 * order, as a stable sort would put them.
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
    if (e.lastUsed === currentFrame || e.key.startsWith('0/')) continue;
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
