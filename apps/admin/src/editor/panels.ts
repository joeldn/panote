import { createContext, useCallback, useContext, useSyncExternalStore } from 'react';

/** The editor's side cards, in the order they stack (and their tabs on a phone). */
export const PANELS = ['panos', 'pano', 'points', 'map'] as const;
export type PanelKey = (typeof PANELS)[number];

export const PANEL_LABELS: Record<PanelKey, string> = {
  panos: 'Panos',
  pano: 'This pano',
  points: 'Points',
  map: 'Map',
};

// The map is the occasional one: it starts folded to its head, the rest start open.
const OPEN_BY_DEFAULT: Record<PanelKey, boolean> = {
  panos: true,
  pano: true,
  points: true,
  map: false,
};

/** Where a card's open or folded state is kept, per browser. */
export const panelStorageKey = (key: PanelKey) => `panote.editor.panel.${key}`;

// What this page last chose for each card, and what storage held just after: storage can
// be blocked, or full (reads work, writes throw), and a toggle must still take. Once storage
// holds something else (cleared, or another tab), storage wins again.
const memory = new Map<PanelKey, { open: boolean; stored: string | null }>();
const listeners = new Set<() => void>();

function stored(key: PanelKey): string | null {
  try {
    return window.localStorage.getItem(panelStorageKey(key));
  } catch {
    return null;
  }
}

function readOpen(key: PanelKey): boolean {
  const now = stored(key);
  const kept = memory.get(key);
  if (kept && kept.stored === now) return kept.open;
  return now === 'open' ? true : now === 'closed' ? false : OPEN_BY_DEFAULT[key];
}

/** Opens or folds a card, and remembers it for the next visit where storage allows. */
export function setPanelOpen(key: PanelKey, open: boolean): void {
  try {
    window.localStorage.setItem(panelStorageKey(key), open ? 'open' : 'closed');
  } catch {
    // Blocked or full: this page still remembers it.
  }
  memory.set(key, { open, stored: stored(key) });
  for (const l of listeners) l();
}

// Another tab folding a card shows here too.
const onStorage = (e: StorageEvent) => {
  if (e.key === null || e.key.startsWith('panote.editor.panel.')) {
    for (const l of listeners) l();
  }
};

const subscribe = (l: () => void) => {
  if (listeners.size === 0) window.addEventListener('storage', onStorage);
  listeners.add(l);
  return () => {
    listeners.delete(l);
    if (listeners.size === 0) window.removeEventListener('storage', onStorage);
  };
};

/** Whether a card is open, and a toggle for it. */
export function usePanelOpen(key: PanelKey): [boolean, () => void] {
  const open = useSyncExternalStore(
    subscribe,
    () => readOpen(key),
    () => OPEN_BY_DEFAULT[key],
  );
  const toggle = useCallback(() => setPanelOpen(key, !readOpen(key)), [key]);
  return [open, toggle];
}

/** The phone layout's media query (design README: `<= 600px` is mobile). */
export const PHONE_QUERY = '(max-width: 600px)';

/** Whether a media query matches now, following it as it changes. False without matchMedia. */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      if (typeof window.matchMedia !== 'function') return () => {};
      const list = window.matchMedia(query);
      list.addEventListener?.('change', onChange);
      return () => list.removeEventListener?.('change', onChange);
    },
    () => typeof window.matchMedia === 'function' && window.matchMedia(query).matches,
    () => false,
  );
}

/**
 * On a phone the cards are one bottom sheet, one card at a time under a tab bar: which tab
 * is showing, and the id prefix that ties the tabs to their cards. Null on a wide screen,
 * where each card stacks and folds on its own.
 */
export interface PanelSheet {
  active: PanelKey;
  idPrefix: string;
}

export const PanelSheetContext = createContext<PanelSheet | null>(null);

export const usePanelSheet = () => useContext(PanelSheetContext);
