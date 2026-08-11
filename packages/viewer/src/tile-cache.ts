export interface EvictCandidate {
  key: string;
  lastUsed: number;
}

/**
 * Choose which tile keys to evict when the cache exceeds maxTiles.
 * Level-0 tiles (keys starting with '0/') are the preview and are never evicted.
 * Evicts least-recently-used non-level-0 tiles first.
 */
export function selectEvictions(entries: EvictCandidate[], maxTiles: number): string[] {
  const overflow = entries.length - maxTiles;
  if (overflow <= 0) return [];
  const evictable = entries
    .filter((e) => !e.key.startsWith('0/'))
    .sort((a, b) => a.lastUsed - b.lastUsed);
  return evictable.slice(0, overflow).map((e) => e.key);
}
