import { render } from '@testing-library/react';
import { loadConfig, type Auth, type AppOrigins, type FetchLike } from '@internal/web-kit';
import { StrictMode } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { vi } from 'vitest';

import { AuthEnvContext } from '../auth-context.js';
import { ConfigContext } from '../config-context.js';
import { routes } from '../routes.js';
import { UploadEnvContext, type UploadEnv } from '../upload/upload-context.js';

export const LOCAL: AppOrigins = {
  website: 'http://localhost:5174',
  admin: 'http://localhost:5173',
};

export const USER = { sub: 'google-oauth2|1', name: 'Maya Larsson', email: 'maya@example.com' };

/** A signed-in `Auth` with every method mocked; override per test. */
export function fakeAuth(overrides: Partial<Auth> = {}): Auth {
  return {
    configured: true,
    connections: [{ id: 'google-oauth2', label: 'Google', icon: 'fa-brands fa-google' }],
    signIn: vi.fn(async () => {}),
    handleCallback: vi.fn(async () => '/app/'),
    getAccessToken: vi.fn(async () => 'jwt-token'),
    isAuthenticated: vi.fn(async () => true),
    getUser: vi.fn(async () => USER),
    signOut: vi.fn(async () => {}),
    ...overrides,
  };
}

// The share route reads VITE_SITE_ORIGIN for its links.
export const TEST_CONFIG = loadConfig({
  VITE_SITE_ORIGIN: 'https://panote.dev',
  VITE_CDN_BASE: 'https://cdn.panote.dev/',
  VITE_AUTH0_DOMAIN: 'panote-dev.au.auth0.com',
  VITE_AUTH0_CLIENT_ID: 'client',
  VITE_AUTH0_AUDIENCE: 'https://api.panote.dev',
});

export interface RenderOptions {
  auth?: Auth;
  fetch?: FetchLike;
  origins?: AppOrigins;
  strict?: boolean;
  /** Upload seams (XHR, tiles base); the default has no tiles base, so uploads can't start. */
  upload?: UploadEnv;
}

export function renderAdmin(path: string, opts: RenderOptions = {}) {
  const auth = opts.auth ?? fakeAuth();
  const assign = vi.fn<(url: string) => void>();
  const router = createMemoryRouter(routes, { basename: '/app', initialEntries: [path] });
  const tree = (
    <AuthEnvContext
      value={{
        auth,
        origins: opts.origins ?? LOCAL,
        assign,
        apiBase: '',
        ...(opts.fetch && { fetch: opts.fetch }),
      }}
    >
      <ConfigContext value={TEST_CONFIG}>
        <UploadEnvContext value={opts.upload ?? {}}>
          <RouterProvider router={router} />
        </UploadEnvContext>
      </ConfigContext>
    </AuthEnvContext>
  );
  render(opts.strict ? <StrictMode>{tree}</StrictMode> : tree);
  return { auth, assign, router };
}
