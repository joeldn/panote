import { render } from '@testing-library/react';
import type { AppOrigins, Auth } from '@internal/web-kit';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { vi } from 'vitest';

import { AuthEnvContext } from '../auth-context.js';
import { routes } from '../routes.js';

export const LOCAL: AppOrigins = {
  website: 'http://localhost:5174',
  admin: 'http://localhost:5173',
};

/** A signed-out `Auth` with every method mocked; override per test. */
export function fakeAuth(overrides: Partial<Auth> = {}): Auth {
  return {
    configured: true,
    connections: [{ id: 'google-oauth2', label: 'Google', icon: 'fa-brands fa-google' }],
    signIn: vi.fn(() => new Promise<void>(() => {})),
    handleCallback: vi.fn(async () => '/app/'),
    getAccessToken: vi.fn(async () => 'jwt-token'),
    isAuthenticated: vi.fn(async () => false),
    getUser: vi.fn(async () => null),
    signOut: vi.fn(async () => {}),
    ...overrides,
  };
}

export function renderSite(path: string, auth: Auth = fakeAuth(), origins: AppOrigins = LOCAL) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(
    <AuthEnvContext value={{ auth, origins }}>
      <RouterProvider router={router} />
    </AuthEnvContext>,
  );
  return { auth, router };
}
