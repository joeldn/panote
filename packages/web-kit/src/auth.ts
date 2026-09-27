import type { Auth0ClientOptions } from '@auth0/auth0-spa-js';

import { KNOWN_CONNECTIONS, type AuthConfig, type ConnectionId } from './config.js';

export interface AuthUser {
  sub?: string;
  name?: string;
  email?: string;
  picture?: string;
}

interface AppState {
  returnTo?: string;
}

/** The subset of `Auth0Client` this wrapper uses; tests inject a fake. */
export interface Auth0Like {
  loginWithRedirect(options: {
    authorizationParams?: { connection?: string; redirect_uri?: string };
    appState?: AppState;
  }): Promise<void>;
  handleRedirectCallback(url?: string): Promise<{ appState?: AppState }>;
  getTokenSilently(): Promise<string>;
  isAuthenticated(): Promise<boolean>;
  getUser(): Promise<AuthUser | undefined>;
  logout(options: { logoutParams: { returnTo: string } }): Promise<void>;
}

export type Auth0Factory = (options: Auth0ClientOptions) => Promise<Auth0Like>;

/** No usable session: the caller should send the user to sign in. */
export class AuthRequiredError extends Error {
  constructor(message = 'sign-in required') {
    super(message);
    this.name = 'AuthRequiredError';
  }
}

export class AuthNotConfiguredError extends Error {
  constructor() {
    super('Auth0 is not configured for this environment');
    this.name = 'AuthNotConfiguredError';
  }
}

// Auth0 error codes meaning "the session is gone", not "something broke".
const SESSION_GONE = new Set(['login_required', 'consent_required', 'missing_refresh_token']);

const errorCode = (e: unknown): string | undefined =>
  e && typeof e === 'object' && 'error' in e && typeof e.error === 'string' ? e.error : undefined;

/**
 * Only same-origin absolute paths survive the round trip through Auth0's
 * `appState`, so a crafted `next=` cannot become an open redirect.
 */
export function safeReturnTo(value: unknown, fallback = '/app/'): string {
  if (typeof value !== 'string') return fallback;
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return fallback;
  return value;
}

export interface SignInConnection {
  id: ConnectionId;
  label: string;
  icon: string;
}

export interface Auth {
  readonly configured: boolean;
  /** The sign-in buttons to render (config-driven; Google only in Wave 6). */
  readonly connections: SignInConnection[];
  signIn(options: { connection: ConnectionId; returnTo?: string }): Promise<void>;
  /** Finish the redirect on the callback route; resolves to the path to go to next. */
  handleCallback(url: string): Promise<string>;
  getAccessToken(): Promise<string>;
  isAuthenticated(): Promise<boolean>;
  getUser(): Promise<AuthUser | null>;
  signOut(returnTo: string): Promise<void>;
}

export interface CreateAuthOptions {
  /** Absolute callback URL, e.g. `${siteOrigin}/app/callback`. */
  redirectUri: string;
  createClient?: Auth0Factory;
}

const defaultFactory: Auth0Factory = async (options) => {
  // Loaded on first use so pages that never touch auth don't ship the SDK.
  const { Auth0Client } = await import('@auth0/auth0-spa-js');
  return new Auth0Client(options) as unknown as Auth0Like;
};

/**
 * Auth0 SPA flow (Authorization Code + PKCE) with rotating refresh tokens in
 * localStorage (D3), so the session survives reloads and is shared by both apps.
 */
export function createAuth(config: AuthConfig, opts: CreateAuthOptions): Auth {
  const factory = opts.createClient ?? defaultFactory;
  let client: Promise<Auth0Like> | undefined;
  const getClient = (): Promise<Auth0Like> => {
    if (!config.configured) return Promise.reject(new AuthNotConfiguredError());
    client ??= factory({
      domain: config.domain,
      clientId: config.clientId,
      authorizationParams: {
        // Without audience Auth0 issues an opaque token that every API 401s.
        audience: config.audience,
        redirect_uri: opts.redirectUri,
        scope: 'openid profile email offline_access',
      },
      cacheLocation: 'localstorage',
      useRefreshTokens: true,
      useRefreshTokensFallback: false,
    });
    return client;
  };

  const connections: SignInConnection[] = config.connections.map((id) => ({
    id,
    ...KNOWN_CONNECTIONS[id],
  }));

  return {
    configured: config.configured,
    connections,
    async signIn({ connection, returnTo }) {
      if (!config.connections.includes(connection)) {
        throw new Error(`sign-in connection not enabled: ${connection}`);
      }
      const c = await getClient();
      await c.loginWithRedirect({
        authorizationParams: { connection, redirect_uri: opts.redirectUri },
        appState: { returnTo: safeReturnTo(returnTo) },
      });
    },
    async handleCallback(url) {
      const c = await getClient();
      const result = await c.handleRedirectCallback(url);
      return safeReturnTo(result.appState?.returnTo);
    },
    async getAccessToken() {
      const c = await getClient().catch((e: unknown) => {
        throw e instanceof AuthNotConfiguredError ? new AuthRequiredError(e.message) : e;
      });
      try {
        return await c.getTokenSilently();
      } catch (e) {
        const code = errorCode(e);
        if (code && SESSION_GONE.has(code)) throw new AuthRequiredError();
        throw e;
      }
    },
    async isAuthenticated() {
      if (!config.configured) return false;
      return (await getClient()).isAuthenticated();
    },
    async getUser() {
      if (!config.configured) return null;
      return (await (await getClient()).getUser()) ?? null;
    },
    async signOut(returnTo) {
      const c = await getClient();
      await c.logout({ logoutParams: { returnTo } });
    },
  };
}
