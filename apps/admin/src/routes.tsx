import type { RouteObject } from 'react-router';

import { Callback } from './Callback.js';
import {
  Dashboard,
  Editor,
  InsightsModal,
  NotFound,
  Preview,
  ShareModal,
  UploadOverlay,
} from './pages.js';
import { RequireAuth } from './RequireAuth.js';
import { Shell } from './Shell.js';

// Paths are relative to the router's /app basename. Everything but the callback is guarded.
export const routes: RouteObject[] = [
  { element: <Shell />, children: [{ path: 'callback', element: <Callback /> }] },
  {
    element: <RequireAuth />,
    children: [
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
          { path: '*', element: <NotFound /> },
        ],
      },
      // Full-screen with their own top bars, so outside Shell (whose bar would sit behind them).
      { path: 't/:tourId/preview', element: <Preview /> },
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
    ],
  },
];
