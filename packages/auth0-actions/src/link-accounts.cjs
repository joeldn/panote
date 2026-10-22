// @ts-check
'use strict';

/*
 * Auth0 post-login Action "Link accounts by verified email".
 *
 * Paste this whole file into the Action's code editor (docs/deploy.md, "Account linking").
 * It needs no npm dependency: the Management API is called with the runtime's `fetch`.
 *
 * Secrets (Action → Secrets), from a Machine to Machine application authorised for the
 * Auth0 Management API with `read:users` and `update:users`:
 *   AUTH0_DOMAIN         the tenant's own domain, e.g. panote-dev.au.auth0.com
 *   MGMT_CLIENT_ID       that M2M application's client id
 *   MGMT_CLIENT_SECRET   that M2M application's client secret
 *
 * On every interactive login with a verified email, it looks up the other Auth0 users with
 * the same email. Of the current user and the others whose email is also verified and who
 * are not blocked, the oldest (created_at, then user_id) is the primary. When that is someone
 * else, the current user is linked into it and the login continues as the primary, so the
 * issued token's `sub` is the primary's and every Panote key stays under it.
 *
 * It never links on an unverified email (anyone can claim an address at some providers), and
 * it never blocks a login: if anything fails, the user signs in unlinked and it is logged.
 */

/**
 * @typedef {object} Identity
 * @property {string} provider
 * @property {string | number} user_id
 * @property {string} [connection]
 */

/**
 * @typedef {object} User
 * @property {string} user_id
 * @property {string} [email]
 * @property {boolean} [email_verified]
 * @property {boolean} [blocked]
 * @property {string} [created_at]
 * @property {Identity[]} [identities]
 */

/**
 * @typedef {object} PostLoginEvent
 * @property {User} user
 * @property {Record<string, string | undefined>} [secrets]
 * @property {{ protocol?: string }} [transaction]
 */

/**
 * @typedef {object} ActionCache
 * @property {(key: string) => { value: string } | undefined} get
 * @property {(key: string, value: string, options?: { expires_at?: number }) => unknown} set
 */

/**
 * @typedef {object} PostLoginApi
 * @property {{ setPrimaryUser: (primaryUserId: string) => void }} authentication
 * @property {ActionCache} [cache]
 */

/**
 * @typedef {object} Management
 * @property {(email: string) => Promise<User[]>} usersByEmail
 * @property {(primaryUserId: string, secondary: { provider: string, user_id: string }) => Promise<void>} link
 */

/**
 * @typedef {(input: string, init?: { method?: string, headers?: Record<string, string>, body?: string }) =>
 *   Promise<{ ok: boolean, status: number, json: () => Promise<unknown> }>} Fetch
 */

const LOG = '[link-accounts]';
const TOKEN_CACHE_KEY = 'mgmt-token';

const sameEmail = (/** @type {string | undefined} */ a, /** @type {string} */ b) =>
  typeof a === 'string' && a.trim().toLowerCase() === b.trim().toLowerCase();

// A missing or unparsable created_at sorts last, so it never wins over a known one.
const createdAt = (/** @type {User} */ u) => {
  const t = u.created_at ? Date.parse(u.created_at) : NaN;
  return Number.isNaN(t) ? Infinity : t;
};

/**
 * The user the current login should become, or null to leave it as it is. Only users
 * with the same verified email who are not blocked take part; the oldest wins, ties broken
 * by user_id, so every login picks the same primary.
 *
 * @param {User} current
 * @param {User[]} found
 * @returns {string | null}
 */
function choosePrimary(current, found) {
  const email = current.email;
  if (!email || current.email_verified !== true) return null;
  const candidates = [
    current,
    ...found.filter(
      (u) =>
        u.user_id !== current.user_id &&
        u.email_verified === true &&
        u.blocked !== true &&
        sameEmail(u.email, email),
    ),
  ];
  candidates.sort(
    (a, b) =>
      createdAt(a) - createdAt(b) || (a.user_id < b.user_id ? -1 : a.user_id > b.user_id ? 1 : 0),
  );
  const primary = candidates[0];
  return primary && primary.user_id !== current.user_id ? primary.user_id : null;
}

/**
 * Management API calls over `fetch`, with the M2M token kept in the Action cache.
 *
 * @param {{ domain: string, clientId: string, clientSecret: string, fetch: Fetch, cache?: ActionCache | undefined, now?: () => number }} options
 * @returns {Management}
 */
function managementClient({ domain, clientId, clientSecret, fetch, cache, now = Date.now }) {
  const base = `https://${domain.replace(/^https?:\/\//, '').replace(/\/+$/, '')}`;

  const token = async () => {
    const cached = cache?.get(TOKEN_CACHE_KEY)?.value;
    if (cached) return cached;
    const res = await fetch(`${base}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
        audience: `${base}/api/v2/`,
      }),
    });
    if (!res.ok) throw new Error(`management token request failed: ${res.status}`);
    const body = /** @type {{ access_token?: unknown, expires_in?: unknown }} */ (await res.json());
    if (typeof body.access_token !== 'string') throw new Error('management token missing');
    const ttl = typeof body.expires_in === 'number' ? body.expires_in : 0;
    // Give it back a minute early, so a cached token never expires mid-call.
    if (ttl > 120)
      cache?.set(TOKEN_CACHE_KEY, body.access_token, { expires_at: now() + (ttl - 60) * 1000 });
    return body.access_token;
  };

  /** @param {string} path @param {{ method?: string, body?: unknown }} [init] */
  const call = async (path, init = {}) => {
    const res = await fetch(`${base}/api/v2${path}`, {
      method: init.method ?? 'GET',
      headers: { authorization: `Bearer ${await token()}`, 'content-type': 'application/json' },
      ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
    });
    if (!res.ok) throw new Error(`management API ${init.method ?? 'GET'} failed: ${res.status}`);
    return res.json();
  };

  return {
    async usersByEmail(email) {
      const users = await call(`/users-by-email?email=${encodeURIComponent(email)}`);
      return Array.isArray(users) ? /** @type {User[]} */ (users) : [];
    },
    async link(primaryUserId, secondary) {
      await call(`/users/${encodeURIComponent(primaryUserId)}/identities`, {
        method: 'POST',
        body: secondary,
      });
    },
  };
}

/**
 * The Action's work, with the Management API and the log passed in (tests use fakes).
 *
 * @param {PostLoginEvent} event
 * @param {PostLoginApi} api
 * @param {{ management: Management | null, log: (...args: unknown[]) => void }} deps
 * @returns {Promise<string | null>} the primary user id it linked into, if any
 */
async function linkAccounts(event, api, { management, log }) {
  const user = event.user;
  // A refresh-token exchange already carries the user the login settled on.
  if (event.transaction?.protocol === 'oauth2-refresh-token') return null;
  if (!user.email || user.email_verified !== true) return null;
  // Only a user with a single identity is linked into another. One that already has
  // linked identities is a primary itself; merging two primaries is left to the operator.
  const identities = user.identities ?? [];
  const identity = identities[0];
  if (identities.length !== 1 || !identity) return null;
  if (!management) {
    log(LOG, 'not configured: set AUTH0_DOMAIN, MGMT_CLIENT_ID and MGMT_CLIENT_SECRET');
    return null;
  }
  try {
    const primary = choosePrimary(user, await management.usersByEmail(user.email));
    if (!primary) return null;
    await management.link(primary, {
      provider: identity.provider,
      user_id: String(identity.user_id),
    });
    api.authentication.setPrimaryUser(primary);
    // Ids only, never the email. Panote data stored under the secondary id (signed in
    // before it was linked) stays there: docs/deploy.md, "Account linking".
    log(LOG, `linked ${user.user_id} into ${primary}`);
    return primary;
  } catch (e) {
    log(LOG, 'linking failed, signing in unlinked:', e instanceof Error ? e.message : String(e));
    return null;
  }
}

/**
 * @param {PostLoginEvent} event
 * @param {PostLoginApi} api
 * @param {Fetch} [fetchImpl]
 * @returns {Management | null}
 */
function managementFromSecrets(event, api, fetchImpl = /** @type {Fetch} */ (globalThis.fetch)) {
  const s = event.secrets ?? {};
  if (!s.AUTH0_DOMAIN || !s.MGMT_CLIENT_ID || !s.MGMT_CLIENT_SECRET) return null;
  return managementClient({
    domain: s.AUTH0_DOMAIN,
    clientId: s.MGMT_CLIENT_ID,
    clientSecret: s.MGMT_CLIENT_SECRET,
    fetch: fetchImpl,
    cache: api.cache,
  });
}

/**
 * Auth0 calls this on every login (Actions → Triggers → post-login).
 *
 * @param {PostLoginEvent} event
 * @param {PostLoginApi} api
 */
exports.onExecutePostLogin = async (event, api) => {
  // console.log is what the Action's real-time logs and Monitoring → Logs show.
  // eslint-disable-next-line no-console
  const log = console.log;
  await linkAccounts(event, api, { management: managementFromSecrets(event, api), log });
};

exports.choosePrimary = choosePrimary;
exports.linkAccounts = linkAccounts;
exports.managementClient = managementClient;
exports.managementFromSecrets = managementFromSecrets;
