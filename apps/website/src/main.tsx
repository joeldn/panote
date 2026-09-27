import '@internal/ui/styles.css';
import '@internal/ui/icons.css';
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
const router = createBrowserRouter(routes);

root.render(
  <StrictMode>
    <ConfigContext value={config}>
      <RouterProvider router={router} />
    </ConfigContext>
  </StrictMode>,
);
