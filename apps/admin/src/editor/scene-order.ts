// Reordering the tour panel's scene list: where a drag drops a scene, and where a key moves it.

/**
 * The index a dragged row lands at, counted in the list without it: the number of other
 * rows whose middle is above the pointer. `mids` are every row's vertical middles, in list
 * order, and `from` is the dragged row's index.
 */
export function dropIndex(mids: readonly number[], y: number, from: number): number {
  return mids.filter((mid, i) => i !== from && mid < y).length;
}

/** Where a key press on a row's move handle sends it, or null for a key that doesn't move. */
export function keyMoveIndex(key: string, from: number, count: number): number | null {
  const to =
    key === 'ArrowUp'
      ? from - 1
      : key === 'ArrowDown'
        ? from + 1
        : key === 'Home'
          ? 0
          : key === 'End'
            ? count - 1
            : null;
  if (to === null) return null;
  const clamped = Math.min(count - 1, Math.max(0, to));
  return clamped === from ? null : clamped;
}

/** What a screen reader hears after a move. */
export const movedLine = (name: string, to: number, count: number): string =>
  `${name} moved to position ${to + 1} of ${count}.`;
