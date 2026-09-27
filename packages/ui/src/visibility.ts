/** Dashboard/share visibility metadata (design `visMeta`; Private deliberately absent). */
export const VISIBILITY_META = {
  public: { label: 'Public', icon: 'fa-solid fa-globe', color: 'var(--vis-public)' },
  unlisted: { label: 'Unlisted', icon: 'fa-solid fa-link', color: 'var(--vis-unlisted)' },
} as const;
export type Visibility = keyof typeof VISIBILITY_META;
