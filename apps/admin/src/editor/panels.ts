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

// Storage can be blocked (private mode, a locked-down browser): then it lasts the page.
const memory = new Map<PanelKey, boolean>();
const listeners = new Set<() => void>();

function readOpen(key: PanelKey): boolean {
  let stored: string | null;
  try {
    stored = window.localStorage.getItem(panelStorageKey(key));
  } catch {
    return memory.get(key) ?? OPEN_BY_DEFAULT[key];
  }
  return stored === 'open' ? true : stored === 'closed' ? false : OPEN_BY_DEFAULT[key];
}

/** Opens or folds a card, and remembers it for the next visit. */
export function setPanelOpen(key: PanelKey, open: boolean): void {
  try {
    window.localStorage.setItem(panelStorageKey(key), open ? 'open' : 'closed');
  } catch {
    memory.set(key, open);
  }
  for (const l of listeners) l();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
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
