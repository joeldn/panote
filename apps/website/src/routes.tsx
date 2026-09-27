import type { RouteObject } from 'react-router';

import { Landing, NotFound, Privacy, Terms, TourEmbed, TourViewer } from './pages.js';
import { Shell } from './Shell.js';

export const routes: RouteObject[] = [
  // Chrome-free so the page can sit inside a third-party iframe.
  { path: '/s/:slug/embed', element: <TourEmbed /> },
  {
    element: <Shell />,
    children: [
      { index: true, element: <Landing /> },
      { path: 's/:slug', element: <TourViewer /> },
      { path: 'privacy', element: <Privacy /> },
      { path: 'terms', element: <Terms /> },
      { path: '*', element: <NotFound /> },
    ],
  },
];
