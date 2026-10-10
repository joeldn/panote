import type { RouteObject } from 'react-router';

import { RouteError } from './RouteError.js';
import { TourError, TourPage } from './tour/TourPage.js';

// Everything under the Shell is its own chunk, so a tour visitor never downloads the
// landing or legal pages. The tour routes stay eager: lazy-loading them would put a chunk
// request in front of the tour data.
const page = (name: 'Landing' | 'Privacy' | 'Terms' | 'NotFound') => async () => ({
  Component: (await import('./pages.js'))[name],
});

export const routes: RouteObject[] = [
  // Full-bleed viewer with its own chrome; the embed has none so it can sit in an iframe.
  { path: '/s/:slug', element: <TourPage />, errorElement: <TourError /> },
  { path: '/s/:slug/embed', element: <TourPage embed />, errorElement: <TourError embed /> },
  {
    lazy: async () => ({ Component: (await import('./Shell.js')).Shell }),
    // The chunks are small; render nothing for the moment they take.
    HydrateFallback: () => null,
    // A chunk missing after a deploy (e.g. the tour bar's home link) reloads once.
    errorElement: <RouteError />,
    children: [
      { index: true, lazy: page('Landing') },
      { path: 'privacy', lazy: page('Privacy') },
      { path: 'terms', lazy: page('Terms') },
      { path: '*', lazy: page('NotFound') },
    ],
  },
];
