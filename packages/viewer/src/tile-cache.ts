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
  const overflow = entries.length - maxTiles;
  if (overflow <= 0) return [];
  const evictable = entries
    .filter((e) => !e.key.startsWith('0/') && e.lastUsed !== currentFrame)
    .sort((a, b) => a.lastUsed - b.lastUsed);
  return evictable.slice(0, overflow).map((e) => e.key);
}
