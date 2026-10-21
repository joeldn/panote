import '@internal/ui/styles.css';
import '@internal/ui/icons.css';
import './app.css';

import {
  appOrigins,
  errorSampleRate,
  installErrorReporter,
  loadConfig,
  releaseFromModuleUrl,
} from '@internal/web-kit';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';

import { AuthEnvContext, type AuthEnv } from './auth-context.js';
import { reloadOnPreloadError } from './chunk-reload.js';
import { ConfigContext } from './config-context.js';
import { routes } from './routes.js';
import { createSiteAuth } from './site-auth.js';

reloadOnPreloadError();

const root = createRoot(document.getElementById('root')!);
const config = loadConfig(import.meta.env);
// Tour slugs in the path are masked by the reporter itself (/s/:slug).
installErrorReporter(window, {
  app: 'website',
  release: releaseFromModuleUrl(import.meta.url),
  baseUrl: config.apiBase,
  sampleRate: errorSampleRate(import.meta.env.MODE),
});
const origins = appOrigins(config.siteOrigin, import.meta.env.DEV);
const authEnv: AuthEnv = { auth: createSiteAuth(config.auth0, origins), origins };
const router = createBrowserRouter(routes);

root.render(
  <StrictMode>
    <ConfigContext value={config}>
      <AuthEnvContext value={authEnv}>
        <RouterProvider router={router} />
      </AuthEnvContext>
    </ConfigContext>
  </StrictMode>,
);
