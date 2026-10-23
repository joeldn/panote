// The help pages (B12): one list for the routes, the footer's Resources column, the pages'
// own side nav and the sitemap (vite.config.ts), so a new page can't miss one of them.

export interface HelpPage {
  path: string;
  /** The footer and side-nav label (design README: Docs / Camera guide / Embedding). */
  label: string;
  /** The page's `<h1>`, and its tab title before " · panote". */
  title: string;
}

export const HELP_PAGES = [
  { path: '/help', label: 'Docs', title: 'Help' },
  { path: '/help/cameras', label: 'Camera guide', title: 'Camera guide' },
  { path: '/help/embedding', label: 'Embedding', title: 'Embedding a tour' },
] as const satisfies readonly HelpPage[];
