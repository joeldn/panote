import type { RouteObject } from 'react-router';

import { Callback } from './Callback.js';
import {
  Account,
  Dashboard,
  Editor,
  InsightsModal,
  Invite,
  NotFound,
  Ops,
  OpsOverview,
  OpsExplore,
  OpsFlags,
  OpsUsers,
  PeopleModal,
  ShareModal,
  UnusedPanos,
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
              { path: 'insights/:tourId', element: <InsightsModal over="dashboard" /> },
            ],
          },
          { path: 'panos/unused', element: <UnusedPanos /> },
          { path: 'account', element: <Account /> },
          // The operator area (ops/sections.ts lists its sections).
          {
            path: 'ops',
            element: <Ops />,
            children: [
              { index: true, element: <OpsOverview /> },
              { path: 'explore', element: <OpsExplore /> },
              { path: 'flags', element: <OpsFlags /> },
              { path: 'users', element: <OpsUsers /> },
            ],
          },
          // An editor invite's link: /app/invite#<token>.
          { path: 'invite', element: <Invite /> },
          { path: '*', element: <NotFound /> },
        ],
      },
      // Full-screen with its own top bar, so outside Shell (whose bar would sit behind it).
      {
        path: 't/:tourId',
        element: <Editor />,
        children: [
          { path: 'share/link', element: <ShareModal tab="link" /> },
          { path: 'share/privacy', element: <ShareModal tab="privacy" /> },
          { path: 'share/embed', element: <ShareModal tab="embed" /> },
          { path: 'insights', element: <InsightsModal /> },
          { path: 'people', element: <PeopleModal /> },
          // Drawn by the editor in its own place, from the tour it holds (unsaved edits too).
          { path: 'preview', element: null },
        ],
      },
    ],
  },
];
