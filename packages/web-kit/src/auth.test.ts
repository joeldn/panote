import { describe, expect, it, vi } from 'vitest';

import {
  AuthNotConfiguredError,
  AuthRequiredError,
  createAuth,
  safeReturnTo,
  type Auth0Like,
} from './auth.js';
import type { AuthConfig } from './config.js';

const config: AuthConfig = {
  domain: 'tenant.example.auth0.com',
  clientId: 'client',
  audience: 'https://api.panote.dev',
  connections: ['google-oauth2'],
  configured: true,
};

function fakeClient(overrides: Partial<Auth0Like> = {}): Auth0Like {
  return {
    loginWithRedirect: vi.fn(async () => {}),
    handleRedirectCallback: vi.fn(async () => ({ appState: { returnTo: '/app/t/abc' } })),
    getTokenSilently: vi.fn(async () => 'jwt'),
    isAuthenticated: vi.fn(async () => true),
    getUser: vi.fn(async () => ({ name: 'Ada' })),
    logout: vi.fn(async () => {}),
    ...overrides,
  };
}

describe('createAuth', () => {
  it('builds the SPA client with audience, refresh tokens and localStorage cache', async () => {
    const client = fakeClient();
    const createClient = vi.fn(async () => client);
    const auth = createAuth(config, {
      redirectUri: 'https://panote.dev/app/callback',
      createClient,
    });
    await auth.getAccessToken();
    await auth.isAuthenticated();
    expect(createClient).toHaveBeenCalledTimes(1);
    expect(createClient).toHaveBeenCalledWith({
      domain: 'tenant.example.auth0.com',
      clientId: 'client',
      authorizationParams: {
        audience: 'https://api.panote.dev',
        redirect_uri: 'https://panote.dev/app/callback',
        scope: 'openid profile email offline_access',
      },
      cacheLocation: 'localstorage',
      useRefreshTokens: true,
      useRefreshTokensFallback: false,
    });
  });

  it('exposes only configured connections (Google only by default)', () => {
    const auth = createAuth(config, { redirectUri: 'x', createClient: async () => fakeClient() });
    expect(auth.connections).toEqual([
      { id: 'google-oauth2', label: 'Google', icon: 'fa-brands fa-google' },
    ]);
  });

  it('signIn redirects with the connection and a sanitised returnTo', async () => {
    const client = fakeClient();
    const auth = createAuth(config, { redirectUri: 'cb', createClient: async () => client });
    await auth.signIn({ connection: 'google-oauth2', returnTo: '//evil.example/x' });
    expect(client.loginWithRedirect).toHaveBeenCalledWith({
      authorizationParams: { connection: 'google-oauth2', redirect_uri: 'cb' },
      appState: { returnTo: '/app/' },
    });
    await expect(auth.signIn({ connection: 'apple' })).rejects.toThrow(/not enabled/);
  });

  it('handleCallback returns the stored path', async () => {
    const auth = createAuth(config, { redirectUri: 'cb', createClient: async () => fakeClient() });
    await expect(
      auth.handleCallback('https://panote.dev/app/callback?code=1&state=2'),
    ).resolves.toBe('/app/t/abc');
  });

  it('maps session-gone errors to AuthRequiredError and rethrows others', async () => {
    const gone = Object.assign(new Error('Login required'), { error: 'login_required' });
    const auth = createAuth(config, {
      redirectUri: 'cb',
      createClient: async () => fakeClient({ getTokenSilently: vi.fn().mockRejectedValue(gone) }),
    });
    await expect(auth.getAccessToken()).rejects.toBeInstanceOf(AuthRequiredError);

    const boom = new Error('network');
    const auth2 = createAuth(config, {
      redirectUri: 'cb',
      createClient: async () => fakeClient({ getTokenSilently: vi.fn().mockRejectedValue(boom) }),
    });
    await expect(auth2.getAccessToken()).rejects.toBe(boom);
  });

  it('never builds a client from placeholder config', async () => {
    const createClient = vi.fn(async () => fakeClient());
    const auth = createAuth({ ...config, configured: false }, { redirectUri: 'cb', createClient });
    await expect(auth.isAuthenticated()).resolves.toBe(false);
    await expect(auth.getUser()).resolves.toBeNull();
    await expect(auth.getAccessToken()).rejects.toBeInstanceOf(AuthRequiredError);
    await expect(auth.signIn({ connection: 'google-oauth2' })).rejects.toBeInstanceOf(
      AuthNotConfiguredError,
    );
    expect(createClient).not.toHaveBeenCalled();
  });

  it('signOut passes returnTo through', async () => {
    const client = fakeClient();
    const auth = createAuth(config, { redirectUri: 'cb', createClient: async () => client });
    await auth.signOut('https://panote.dev/');
    expect(client.logout).toHaveBeenCalledWith({
      logoutParams: { returnTo: 'https://panote.dev/' },
    });
  });
});

describe('safeReturnTo', () => {
  it.each([
    ['/app/t/1?pano=2', '/app/t/1?pano=2'],
    ['//evil.example', '/app/'],
    ['/\\evil.example', '/app/'],
    ['https://evil.example', '/app/'],
    [undefined, '/app/'],
    [42, '/app/'],
  ])('%s -> %s', (input, out) => {
    expect(safeReturnTo(input)).toBe(out);
  });
});
