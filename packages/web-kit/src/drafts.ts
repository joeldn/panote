// The admin editor parks unsaved edits in localStorage under this prefix across a
// re-auth redirect. Both apps share the origin, so either one's sign-out sweeps them.
export const EDITOR_DRAFT_PREFIX = 'panote:editor-draft:';

/** Drop every parked editor draft in this browser (call on sign-out). */
export function sweepEditorDrafts(storage?: Pick<Storage, 'length' | 'key' | 'removeItem'>): void {
  try {
    const store = storage ?? globalThis.localStorage;
    const keys: string[] = [];
    for (let i = 0; i < store.length; i++) {
      const k = store.key(i);
      if (k?.startsWith(EDITOR_DRAFT_PREFIX)) keys.push(k);
    }
    for (const k of keys) store.removeItem(k);
  } catch {
    // Storage unavailable: nothing is parked there either.
  }
}
