import type { RouteObject } from 'react-router';

import { Landing, NotFound, Privacy, Terms } from './pages.js';
import { Shell } from './Shell.js';
import { TourError, TourPage } from './tour/TourPage.js';

export const routes: RouteObject[] = [
  // Full-bleed viewer with its own chrome; the embed has none so it can sit in an iframe.
  { path: '/s/:slug', element: <TourPage />, errorElement: <TourError /> },
  { path: '/s/:slug/embed', element: <TourPage embed />, errorElement: <TourError embed /> },
  {
    element: <Shell />,
    children: [
      { index: true, element: <Landing /> },
      { path: 'privacy', element: <Privacy /> },
      { path: 'terms', element: <Terms /> },
      { path: '*', element: <NotFound /> },
    ],
  },
];
