// Tokens are cached in localStorage (D3). That is only acceptable while the Auth0
// tenant keeps refresh-token rotation and reuse detection enabled.
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
// invalid_grant: the refresh token expired, was revoked, or reuse was detected.
const SESSION_GONE = new Set([
  'login_required',
  'consent_required',
  'missing_refresh_token',
  'invalid_grant',
]);

// Error classes from the lazily loaded SDK, registered once it is imported.
const sessionGoneClasses: Array<abstract new (...args: never[]) => Error> = [];

const errorCode = (e: unknown): string | undefined =>
  e && typeof e === 'object' && 'error' in e && typeof e.error === 'string' ? e.error : undefined;

/** True for an SDK error that means the user has to sign in again. */
export function isSessionGoneError(e: unknown): boolean {
  if (sessionGoneClasses.some((cls) => e instanceof cls)) return true;
  const code = errorCode(e);
  return code !== undefined && SESSION_GONE.has(code);
}

/** True for any error meaning "sign in again": a gone session or an API 401. */
export const isAuthError = (e: unknown): e is AuthRequiredError => e instanceof AuthRequiredError;

// C0 controls are stripped by the WHATWG URL parser ("/\t/evil" -> "//evil"),
// and browsers treat a backslash as "/", so both are refused before resolving.
const hasUnsafeChars = (v: string): boolean =>
  [...v].some((ch) => ch === '\\' || ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f);

const SAFE_PATH = /^\/(?![/\\])/;

/**
 * Resolve `value` against `origin` and keep it only if it stays on that origin,
 * returned as path + query + hash, so a crafted `next=` can't open-redirect.
 */
export function safeReturnTo(value: unknown, origin: string, fallback = '/app/'): string {
  if (typeof value !== 'string' || value === '' || hasUnsafeChars(value)) return fallback;
  let base: string;
  let url: URL;
  try {
    base = new URL(origin).origin;
    url = new URL(value, base);
  } catch {
    return fallback;
  }
  // Dot segments can normalise "/.//evil" to a "//evil" path, which a browser
  // would read as protocol-relative; the last check fails closed on any such form.
  if (url.origin !== base || url.pathname.startsWith('//')) return fallback;
  const path = `${url.pathname}${url.search}${url.hash}`;
  return SAFE_PATH.test(path) ? path : fallback;
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
  /** Absolute callback URL, e.g. `${siteOrigin}/app/callback`; its origin bounds returnTo. */
  redirectUri: string;
  /** The callback runs on another origin (local dev ports): keep the PKCE transaction in a cookie. */
  crossOriginCallback?: boolean;
  createClient?: Auth0Factory;
  /**
   * Answer `isAuthenticated`/`getUser` as signed out, without loading the SDK, while
   * its localStorage cache has no entry for this client (see `hasCachedSession`).
   */
  requireCachedSession?: boolean;
  /** Where that cache is read from; defaults to `localStorage`. Tests inject one. */
  cacheStorage?: Pick<Storage, 'length' | 'key'>;
}

// The SDK's LocalStorageCache prefixes every key with this (cache/shared.ts in
// @auth0/auth0-spa-js); entries are `@@auth0spajs@@::<clientId>::<audience>::<scope>`
// plus `@@auth0spajs@@::<clientId>::@@user@@`.
const SDK_CACHE_PREFIX = '@@auth0spajs@@';

/**
 * True when the Auth0 SDK's localStorage cache holds anything for `clientId`. With
 * `cacheLocation: 'localstorage'` the SDK's own `isAuthenticated()` only reads that
 * cache, so no entry means it would answer false anyway. Storage that can't be read
 * (private mode, blocked site data) counts as no session; the SDK couldn't use it either.
 */
export function hasCachedSession(
  clientId: string,
  storage?: Pick<Storage, 'length' | 'key'>,
): boolean {
  try {
    const s = storage ?? globalThis.localStorage;
    const prefix = `${SDK_CACHE_PREFIX}::${clientId}::`;
    for (let i = 0; i < s.length; i++) {
      if (s.key(i)?.startsWith(prefix)) return true;
    }
  } catch {
    // Fall through: treated as signed out.
  }
  return false;
}

const defaultFactory: Auth0Factory = async (options) => {
  // Loaded on first use so pages that never touch auth don't ship the SDK.
  const sdk = await import('@auth0/auth0-spa-js');
  if (!sessionGoneClasses.includes(sdk.MissingRefreshTokenError)) {
    sessionGoneClasses.push(sdk.MissingRefreshTokenError);
  }
  return new sdk.Auth0Client(options) as unknown as Auth0Like;
};

/**
 * Auth0 SPA flow (Authorization Code + PKCE) with rotating refresh tokens in
 * localStorage (D3), so the session survives reloads and is shared by both apps.
 */
export function createAuth(config: AuthConfig, opts: CreateAuthOptions): Auth {
  const factory = opts.createClient ?? defaultFactory;
  const origin = new URL(opts.redirectUri).origin;
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
      ...(opts.crossOriginCallback && { useCookiesForTransactions: true }),
    });
    const pending = client;
    // Forget a failed load (e.g. a chunk fetch) so the next call can retry.
    pending.catch(() => {
      if (client === pending) client = undefined;
    });
    return pending;
  };

  // Skips the ~62 kB gz SDK chunk for visitors who have never signed in on this origin.
  const noCachedSession = (): boolean =>
    !!opts.requireCachedSession && !hasCachedSession(config.clientId, opts.cacheStorage);

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
        appState: { returnTo: safeReturnTo(returnTo, origin) },
      });
    },
    async handleCallback(url) {
      const c = await getClient();
      const result = await c.handleRedirectCallback(url);
      return safeReturnTo(result.appState?.returnTo, origin);
    },
    async getAccessToken() {
      const c = await getClient().catch((e: unknown) => {
        throw e instanceof AuthNotConfiguredError ? new AuthRequiredError(e.message) : e;
      });
      try {
        return await c.getTokenSilently();
      } catch (e) {
        if (isSessionGoneError(e)) throw new AuthRequiredError();
        throw e;
      }
    },
    async isAuthenticated() {
      if (!config.configured || noCachedSession()) return false;
      return (await getClient()).isAuthenticated();
    },
    async getUser() {
      if (!config.configured || noCachedSession()) return null;
      return (await (await getClient()).getUser()) ?? null;
    },
    async signOut(returnTo) {
      const c = await getClient();
      await c.logout({ logoutParams: { returnTo } });
    },
  };
}
