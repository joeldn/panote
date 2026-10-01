import { render } from '@testing-library/react';
import type { AppConfig, Auth, AppOrigins, FetchLike } from '@internal/web-kit';
import { StrictMode } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { vi } from 'vitest';

import { AuthEnvContext } from '../auth-context.js';
import { ConfigContext } from '../config-context.js';
import { routes } from '../routes.js';

export const LOCAL: AppOrigins = {
  website: 'http://localhost:5174',
  admin: 'http://localhost:5173',
};

export const TEST_CONFIG: AppConfig = {
  siteOrigin: 'https://panote.test',
  cdnBase: 'https://cdn.panote.test/',
  apiBase: '',
  auth0: {
    domain: 'panote-test.auth0.com',
    clientId: 'client',
    audience: 'https://api.panote.test',
    connections: ['google-oauth2'],
    configured: true,
  },
  showcaseSlug: null,
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

export interface RenderOptions {
  auth?: Auth;
  fetch?: FetchLike;
  origins?: AppOrigins;
  strict?: boolean;
  config?: AppConfig;
}

export function renderAdmin(path: string, opts: RenderOptions = {}) {
  const auth = opts.auth ?? fakeAuth();
  const assign = vi.fn<(url: string) => void>();
  const router = createMemoryRouter(routes, { basename: '/app', initialEntries: [path] });
  const tree = (
    <ConfigContext value={opts.config ?? TEST_CONFIG}>
      <AuthEnvContext
        value={{
          auth,
          origins: opts.origins ?? LOCAL,
          assign,
          apiBase: '',
          ...(opts.fetch && { fetch: opts.fetch }),
        }}
      >
        <RouterProvider router={router} />
      </AuthEnvContext>
    </ConfigContext>
  );
  render(opts.strict ? <StrictMode>{tree}</StrictMode> : tree);
  return { auth, assign, router };
}
