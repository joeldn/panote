import { describe, expect, it, vi } from 'vitest';

import {
  AuthNotConfiguredError,
  AuthRequiredError,
  createAuth,
  hasCachedSession,
  isAuthError,
  isSessionGoneError,
  safeReturnTo,
  type Auth0Like,
} from './auth.js';
import type { AuthConfig } from './config.js';

const CB = 'https://panote.dev/app/callback';

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

  it('keeps the PKCE transaction in a cookie when the callback is on another origin', async () => {
    const createClient = vi.fn(async () => fakeClient());
    const auth = createAuth(config, { redirectUri: CB, crossOriginCallback: true, createClient });
    await auth.isAuthenticated();
    expect(createClient).toHaveBeenCalledWith(
      expect.objectContaining({ useCookiesForTransactions: true }),
    );
  });

  it('exposes only configured connections (Google only by default)', () => {
    const auth = createAuth(config, { redirectUri: CB, createClient: async () => fakeClient() });
    expect(auth.connections).toEqual([
      { id: 'google-oauth2', label: 'Google', icon: 'fa-brands fa-google' },
    ]);
  });

  it('signIn redirects with the connection and a sanitised returnTo', async () => {
    const client = fakeClient();
    const auth = createAuth(config, { redirectUri: CB, createClient: async () => client });
    await auth.signIn({ connection: 'google-oauth2', returnTo: '//evil.example/x' });
    expect(client.loginWithRedirect).toHaveBeenCalledWith({
      authorizationParams: { connection: 'google-oauth2', redirect_uri: CB },
      appState: { returnTo: '/app/' },
    });
    await expect(auth.signIn({ connection: 'apple' })).rejects.toThrow(/not enabled/);
  });

  it('handleCallback returns the stored path', async () => {
    const auth = createAuth(config, { redirectUri: CB, createClient: async () => fakeClient() });
    await expect(
      auth.handleCallback('https://panote.dev/app/callback?code=1&state=2'),
    ).resolves.toBe('/app/t/abc');
  });

  it('maps session-gone errors to AuthRequiredError and rethrows others', async () => {
    const gone = Object.assign(new Error('Login required'), { error: 'login_required' });
    const auth = createAuth(config, {
      redirectUri: CB,
      createClient: async () => fakeClient({ getTokenSilently: vi.fn().mockRejectedValue(gone) }),
    });
    await expect(auth.getAccessToken()).rejects.toBeInstanceOf(AuthRequiredError);

    const boom = new Error('network');
    const auth2 = createAuth(config, {
      redirectUri: CB,
      createClient: async () => fakeClient({ getTokenSilently: vi.fn().mockRejectedValue(boom) }),
    });
    await expect(auth2.getAccessToken()).rejects.toBe(boom);
  });

  it('maps an invalid_grant refresh failure to AuthRequiredError', async () => {
    const revoked = Object.assign(new Error('Unknown or invalid refresh token.'), {
      error: 'invalid_grant',
    });
    const auth = createAuth(config, {
      redirectUri: CB,
      createClient: async () =>
        fakeClient({ getTokenSilently: vi.fn().mockRejectedValue(revoked) }),
    });
    await expect(auth.getAccessToken()).rejects.toBeInstanceOf(AuthRequiredError);
  });

  it('retries the client factory after a failed load instead of caching the failure', async () => {
    const client = fakeClient();
    const createClient = vi
      .fn<() => Promise<Auth0Like>>()
      .mockRejectedValueOnce(new Error('Failed to fetch dynamically imported module'))
      .mockResolvedValue(client);
    const auth = createAuth(config, { redirectUri: CB, createClient });
    await expect(auth.getAccessToken()).rejects.toThrow(/dynamically imported/);
    await expect(auth.getAccessToken()).resolves.toBe('jwt');
    expect(createClient).toHaveBeenCalledTimes(2);
  });

  it('never builds a client from placeholder config', async () => {
    const createClient = vi.fn(async () => fakeClient());
    const auth = createAuth({ ...config, configured: false }, { redirectUri: CB, createClient });
    await expect(auth.isAuthenticated()).resolves.toBe(false);
    await expect(auth.getUser()).resolves.toBeNull();
    await expect(auth.getAccessToken()).rejects.toBeInstanceOf(AuthRequiredError);
    await expect(auth.signIn({ connection: 'google-oauth2' })).rejects.toBeInstanceOf(
      AuthNotConfiguredError,
    );
    expect(createClient).not.toHaveBeenCalled();
  });

  describe('requireCachedSession', () => {
    const storage = (...keys: string[]) => ({
      length: keys.length,
      key: (i: number) => keys[i] ?? null,
    });
    const userKey = `@@auth0spajs@@::${config.clientId}::@@user@@`;

    it('answers signed out without loading the SDK when the cache is empty', async () => {
      const createClient = vi.fn(async () => fakeClient());
      const auth = createAuth(config, {
        redirectUri: CB,
        createClient,
        requireCachedSession: true,
        cacheStorage: storage('unrelated', '@@auth0spajs@@::other-client::@@user@@'),
      });
      await expect(auth.isAuthenticated()).resolves.toBe(false);
      await expect(auth.getUser()).resolves.toBeNull();
      expect(createClient).not.toHaveBeenCalled();
    });

    it('asks the SDK once its cache has an entry for this client', async () => {
      const createClient = vi.fn(async () => fakeClient());
      const auth = createAuth(config, {
        redirectUri: CB,
        createClient,
        requireCachedSession: true,
        cacheStorage: storage(userKey),
      });
      await expect(auth.isAuthenticated()).resolves.toBe(true);
      await expect(auth.getUser()).resolves.toEqual({ name: 'Ada' });
      expect(createClient).toHaveBeenCalledTimes(1);
    });

    it('still loads the SDK to sign in', async () => {
      const createClient = vi.fn(async () => fakeClient());
      const auth = createAuth(config, {
        redirectUri: CB,
        createClient,
        requireCachedSession: true,
        cacheStorage: storage(),
      });
      await auth.signIn({ connection: 'google-oauth2' });
      expect(createClient).toHaveBeenCalledTimes(1);
    });
  });

  it('hasCachedSession treats unreadable storage as no session', () => {
    const throwing = {
      get length(): number {
        throw new DOMException('denied', 'SecurityError');
      },
      key: () => null,
    };
    expect(hasCachedSession('client', throwing)).toBe(false);
  });

  it('signOut passes returnTo through', async () => {
    const client = fakeClient();
    const auth = createAuth(config, { redirectUri: CB, createClient: async () => client });
    await auth.signOut('https://panote.dev/');
    expect(client.logout).toHaveBeenCalledWith({
      logoutParams: { returnTo: 'https://panote.dev/' },
    });
  });
});

describe('safeReturnTo', () => {
  const origin = 'https://panote.dev';
  const accepted: Array<[string, string]> = [
    ['/app/t/1?pano=2#h', '/app/t/1?pano=2#h'],
    ['https://panote.dev/app/t/1?x=1', '/app/t/1?x=1'],
    ['https://panote.dev', '/'],
    ['/app/../s/abc', '/s/abc'],
    ['/./app/', '/app/'],
    ['app/t/1', '/app/t/1'],
    // Percent-encoded controls stay encoded on our own origin.
    ['/%09/evil.example', '/%09/evil.example'],
  ];
  const rejected: unknown[] = [
    '/\t/evil.example',
    '/\n/evil.example',
    '/\r/evil.example',
    '/\t\n\r/evil.example',
    decodeURIComponent('/%09/evil.example'),
    decodeURIComponent('/%0a/evil.example'),
    '//evil.example',
    '/\\evil.example',
    '\\\\evil.example',
    'javascript:alert(1)',
    ' javascript:alert(1)',
    'https://evil.example/app/',
    'http://panote.dev/app/',
    'https://panote.dev.evil.example/',
    // Dot segments or an empty first segment normalising to a "//host" path.
    '/.//evil.com',
    '/..//evil.com',
    '/app/..//evil.com',
    '/%2e%2e//evil.com',
    '/%2e//evil.com',
    './/evil.com',
    '..//evil.com',
    'https://panote.dev//evil.com',
    'HTTPS://PANOTE.DEV//evil.com',
    'https://panote.dev:443//evil.com',
    '/app/%2e%2e/%2e%2e//evil.com',
    '',
    undefined,
    42,
  ];

  it.each(accepted)('accepts %j -> %j', (input, out) => {
    expect(safeReturnTo(input, origin)).toBe(out);
  });

  it.each(rejected)('rejects %j', (input) => {
    expect(safeReturnTo(input, origin)).toBe('/app/');
  });

  it('every result, accepted or fallback, stays on the origin when navigated to', () => {
    for (const input of [...accepted.map(([i]) => i), ...rejected]) {
      const result = safeReturnTo(input, origin);
      expect(result).toMatch(/^\/(?![/\\])/);
      expect(new URL(result, origin).origin).toBe(origin);
      // Resolving against a page deep in the site must not escape either.
      expect(new URL(result, `${origin}/app/t/abc`).origin).toBe(origin);
    }
  });

  it('never resolves a rejected-class input to another origin', () => {
    // The WHATWG parser strips C0 controls, which is how "/\t/x" became "//x".
    expect(new URL('/\t/evil.example', origin).origin).not.toBe(origin);
    expect(new URL(new URL('/.//evil.com', origin).pathname, origin).origin).not.toBe(origin);
    expect(safeReturnTo('/\t/evil.example', origin, '/fallback')).toBe('/fallback');
  });
});

describe('isSessionGoneError / isAuthError', () => {
  it.each(['login_required', 'consent_required', 'missing_refresh_token', 'invalid_grant'])(
    '%s means sign in again',
    (code) => {
      expect(isSessionGoneError(Object.assign(new Error(code), { error: code }))).toBe(true);
    },
  );

  it('other errors are not session-gone', () => {
    expect(isSessionGoneError(Object.assign(new Error('x'), { error: 'timeout' }))).toBe(false);
    expect(isSessionGoneError(new Error('network'))).toBe(false);
    expect(isSessionGoneError(null)).toBe(false);
  });

  it('isAuthError matches AuthRequiredError only', () => {
    expect(isAuthError(new AuthRequiredError())).toBe(true);
    expect(isAuthError(new Error('sign-in required'))).toBe(false);
  });
});
