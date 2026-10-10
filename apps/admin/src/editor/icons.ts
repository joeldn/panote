import { POINT_ICONS } from '@internal/ui';

// The picker offers only POINT_ICONS: they are in the subset font (@internal/ui
// icons.css), so a typed-in name outside it would render as the fallback icon.
export function searchIcons(query: string): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...POINT_ICONS];
  return POINT_ICONS.filter((name) => name.includes(q));
}
