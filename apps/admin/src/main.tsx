import '@internal/ui/styles.css';
import '@internal/ui/icons.css';
import './app.css';

import { appOrigins, callbackUrl, createAuth, loadConfig } from '@internal/web-kit';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';

import { AuthEnvContext, type AuthEnv } from './auth-context.js';
import { ConfigContext } from './config-context.js';
import { routes } from './routes.js';

const root = createRoot(document.getElementById('root')!);
const config = loadConfig(import.meta.env);
const origins = appOrigins(config.siteOrigin, import.meta.env.DEV);
// One auth instance per page load; both apps share the session through localStorage.
const authEnv: AuthEnv = {
  auth: createAuth(config.auth0, {
    redirectUri: callbackUrl(origins),
    crossOriginCallback: origins.website !== origins.admin,
  }),
  origins,
  assign: (url) => window.location.assign(url),
  apiBase: config.apiBase,
};
// BASE_URL is Vite's `base` ('/app/'); the router wants it without the trailing slash.
const router = createBrowserRouter(routes, {
  basename: import.meta.env.BASE_URL.replace(/\/$/, ''),
});

root.render(
  <StrictMode>
    <ConfigContext value={config}>
      <AuthEnvContext value={authEnv}>
        <RouterProvider router={router} />
      </AuthEnvContext>
    </ConfigContext>
  </StrictMode>,
);
