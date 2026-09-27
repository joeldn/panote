import '@internal/ui/styles.css';
import './app.css';

import { loadConfig } from '@internal/web-kit';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';

import { ConfigContext } from './config-context.js';
import { routes } from './routes.js';

const root = createRoot(document.getElementById('root')!);
const config = loadConfig(import.meta.env);
// BASE_URL is Vite's `base` ('/app/'); the router wants it without the trailing slash.
const router = createBrowserRouter(routes, {
  basename: import.meta.env.BASE_URL.replace(/\/$/, ''),
});

root.render(
  <StrictMode>
    <ConfigContext value={config}>
      <RouterProvider router={router} />
    </ConfigContext>
  </StrictMode>,
);
