import type { RouteObject } from 'react-router';

import {
  Callback,
  Dashboard,
  Editor,
  InsightsModal,
  NotFound,
  Preview,
  ShareModal,
  UploadOverlay,
} from './pages.js';
import { Shell } from './Shell.js';

// Paths are relative to the router's /app basename.
export const routes: RouteObject[] = [
  {
    element: <Shell />,
    children: [
      {
        element: <Dashboard />,
        children: [
          { index: true, element: null },
          { path: 'new', element: <UploadOverlay /> },
        ],
      },
      { path: 'callback', element: <Callback /> },
      {
        path: 't/:tourId',
        element: <Editor />,
        children: [
          { path: 'share/link', element: <ShareModal tab="link" /> },
          { path: 'share/privacy', element: <ShareModal tab="privacy" /> },
          { path: 'share/embed', element: <ShareModal tab="embed" /> },
          { path: 'insights', element: <InsightsModal /> },
        ],
      },
      { path: 't/:tourId/preview', element: <Preview /> },
      { path: '*', element: <NotFound /> },
    ],
  },
];
