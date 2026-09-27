import { describe, expect, it, vi } from 'vitest';

import { AuthRequiredError, createAuth, isSessionGoneError } from './auth.js';

// Stand-ins for the real SDK classes; the default factory imports this module lazily.
vi.mock('@auth0/auth0-spa-js', () => {
  class MissingRefreshTokenError extends Error {}
  class Auth0Client {
    constructor(readonly options: unknown) {}
    getTokenSilently() {
      // No `error` code on purpose: only the class identifies it.
      return Promise.reject(new MissingRefreshTokenError('Missing Refresh Token'));
    }
  }
  return { Auth0Client, MissingRefreshTokenError };
});

describe('default Auth0 factory', () => {
  it('loads the SDK lazily and recognises MissingRefreshTokenError by class', async () => {
    const sdk = await import('@auth0/auth0-spa-js');
    const bare = new sdk.MissingRefreshTokenError('aud', 'scope');
    expect(isSessionGoneError(bare)).toBe(false);

    const auth = createAuth(
      {
        domain: 'tenant.example.auth0.com',
        clientId: 'c',
        audience: 'https://api.panote.dev',
        connections: ['google-oauth2'],
        configured: true,
      },
      { redirectUri: 'https://panote.dev/app/callback' },
    );
    await expect(auth.getAccessToken()).rejects.toBeInstanceOf(AuthRequiredError);
    expect(isSessionGoneError(bare)).toBe(true);
  });
});
