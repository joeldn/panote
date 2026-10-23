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
 * On every interactive login through a trusted provider (TRUSTED_PROVIDERS) with a verified
 * email, it looks up the other Auth0 users with that email. Of the current user and the
 * others that hold a trusted identity with that same verified email and are not blocked, the
 * oldest (created_at, then user_id) is the primary. When that is someone else, the current
 * user is linked into it and the login continues as the primary, so the issued token's `sub`
 * is the primary's and every Panote key stays under it.
 *
 * Linking is automatic, without asking the user to sign in to the other account first; the
 * owner chose that (docs/decisions.md, "Account linking"). The provider allowlist is what
 * keeps it safe. It never blocks a login: if anything fails, the user signs in unlinked and
 * it is logged.
 *
 * It also puts two custom claims on every access token (admin-api reads them; the names
 * match AUTH_TIME_CLAIM and LINKED_SUBS_CLAIM in packages/contracts/src/jwt.ts):
 * - AUTH_TIME_CLAIM: when the user last actually signed in (epoch seconds). Account deletion
 *   wants a recent one. Left off a refresh-token exchange, so a stolen refresh token can't
 *   mint a "just signed in" token.
 * - LINKED_SUBS_CLAIM: the user ids of the identities linked into this user, so account
 *   deletion also removes Panote data made under one of them before it was linked.
 */

/**
 * Providers whose `email_verified: true` we trust to mean the person controls that address,
 * on both sides of a link. Anything else signs in normally but is never joined.
 * - email: Auth0 passwordless, the one-time code itself proves the address.
 * - google-oauth2, apple: the provider verifies the address it reports.
 * Left out until reviewed: windowslive (Microsoft has a history of unverified email claims),
 * facebook.
 */
const TRUSTED_PROVIDERS = Object.freeze(['email', 'google-oauth2', 'apple']);

/** Custom access-token claims; Auth0 drops any claim not namespaced with a URL. */
const AUTH_TIME_CLAIM = 'https://panote.io/auth_time';
const LINKED_SUBS_CLAIM = 'https://panote.io/linked_subs';
/** admin-api reads no more than this many linked subs (MAX_LINKED_SUBS in contracts). */
const MAX_LINKED_SUBS = 10;

/** Each Management API and token call gives up after this, so a hung API can't fail a login. */
const TIMEOUT_MS = 5000;

/**
 * The whole run, retries included, gives up after this and lets the login go on unlinked.
 * Auth0 stops an Action at about 20 s, which would fail the login itself.
 */
const DEADLINE_MS = 10_000;

/**
 * @typedef {object} Identity
 * @property {string} provider
 * @property {string | number} user_id
 * @property {string} [connection]
 * @property {{ email?: string, email_verified?: boolean }} [profileData]
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
 * @property {{ methods?: { name?: string, timestamp?: string }[] }} [authentication]
 */

/**
 * @typedef {object} ActionCache
 * @property {(key: string) => { value: string } | undefined} get
 * @property {(key: string, value: string, options?: { expires_at?: number }) => unknown} set
 * @property {(key: string) => unknown} [delete]
 */

/**
 * @typedef {object} PostLoginApi
 * @property {{ setPrimaryUser: (primaryUserId: string) => void }} authentication
 * @property {{ setCustomClaim: (name: string, value: unknown) => void }} [accessToken]
 * @property {ActionCache} [cache]
 */

/**
 * @typedef {object} Management
 * @property {(email: string, signal?: AbortSignal) => Promise<User[]>} usersByEmail
 * @property {(primaryUserId: string, secondary: { provider: string, user_id: string }, signal?: AbortSignal) => Promise<void>} link
 */

/**
 * @typedef {(input: string, init?: { method?: string, headers?: Record<string, string>, body?: string, signal?: AbortSignal }) =>
 *   Promise<{ ok: boolean, status: number, json: () => Promise<unknown> }>} Fetch
 */

/** A failed Management API call, with its HTTP status. */
class ManagementError extends Error {
  /** @param {string} message @param {number} status */
  constructor(message, status) {
    super(message);
    this.name = 'ManagementError';
    this.status = status;
  }
}

const LOG = '[link-accounts]';
const TOKEN_CACHE_KEY = 'mgmt-token';

const sameEmail = (/** @type {string | undefined} */ a, /** @type {string} */ b) =>
  typeof a === 'string' && a.trim().toLowerCase() === b.trim().toLowerCase();

const isTrusted = (/** @type {string} */ provider) => TRUSTED_PROVIDERS.includes(provider);

/**
 * Whether `u` holds an identity from a trusted provider that carries `email`, verified. The
 * user's own identity (the one its user_id is made of) carries the root email; a linked
 * identity carries its own in profileData.
 *
 * @param {User} u
 * @param {string} email
 */
function hasTrustedIdentity(u, email) {
  return (u.identities ?? []).some((id) => {
    if (!isTrusted(id.provider)) return false;
    const own = `${id.provider}|${id.user_id}` === u.user_id;
    const claim = own ? u : id.profileData;
    return claim?.email_verified === true && sameEmail(claim.email, email);
  });
}

// A missing or unparsable created_at sorts last, so it never wins over a known one.
const createdAt = (/** @type {User} */ u) => {
  const t = u.created_at ? Date.parse(u.created_at) : NaN;
  return Number.isNaN(t) ? Infinity : t;
};

/**
 * The user the current login should become, or null to leave it as it is. Only users that
 * hold a trusted identity with the same verified email and are not blocked take part; the
 * oldest wins, ties broken by user_id, so every login picks the same primary.
 *
 * @param {User} current
 * @param {User[]} found
 * @returns {string | null}
 */
function choosePrimary(current, found) {
  const email = current.email;
  if (!email || !hasTrustedIdentity(current, email)) return null;
  const candidates = [
    current,
    ...found.filter(
      (u) => u.user_id !== current.user_id && u.blocked !== true && hasTrustedIdentity(u, email),
    ),
  ];
  candidates.sort(
    (a, b) =>
      createdAt(a) - createdAt(b) || (a.user_id < b.user_id ? -1 : a.user_id > b.user_id ? 1 : 0),
  );
  const primary = candidates[0];
  return primary && primary.user_id !== current.user_id ? primary.user_id : null;
}

const isRefresh = (/** @type {PostLoginEvent} */ event) =>
  event.transaction?.protocol === 'oauth2-refresh-token';

/**
 * The user ids of the identities linked into `u` (each as it was before the link:
 * `<provider>|<id>`), plus `also`, without `u`'s own, at most MAX_LINKED_SUBS.
 *
 * @param {User} u
 * @param {string[]} [also]
 * @returns {string[]}
 */
function linkedSubsOf(u, also = []) {
  const subs = [...(u.identities ?? []).map((id) => `${id.provider}|${id.user_id}`), ...also];
  return [...new Set(subs)].filter((s) => s !== u.user_id).slice(0, MAX_LINKED_SUBS);
}

/**
 * When the user last actually signed in, in epoch seconds: the latest of the session's
 * authentication methods. Undefined on a refresh-token exchange, or when Auth0 gives none.
 *
 * @param {PostLoginEvent} event
 * @returns {number | undefined}
 */
function authTimeOf(event) {
  if (isRefresh(event)) return undefined;
  let latest = -Infinity;
  for (const m of event.authentication?.methods ?? []) {
    const t = m.timestamp ? Date.parse(m.timestamp) : NaN;
    if (t > latest) latest = t;
  }
  return Number.isFinite(latest) ? Math.floor(latest / 1000) : undefined;
}

/**
 * Management API calls over `fetch`, with the M2M token kept in the Action cache.
 *
 * @param {{ domain: string, clientId: string, clientSecret: string, fetch: Fetch, cache?: ActionCache | undefined, now?: () => number, timeoutMs?: number }} options
 * @returns {Management}
 */
function managementClient({
  domain,
  clientId,
  clientSecret,
  fetch,
  cache,
  now = Date.now,
  timeoutMs = TIMEOUT_MS,
}) {
  const base = `https://${domain.replace(/^https?:\/\//, '').replace(/\/+$/, '')}`;

  // Each call's own timeout, combined with the caller's deadline when there is one.
  const signalFor = (/** @type {AbortSignal | undefined} */ deadline) =>
    deadline
      ? AbortSignal.any([AbortSignal.timeout(timeoutMs), deadline])
      : AbortSignal.timeout(timeoutMs);

  /** @type {Promise<string> | null} */
  let pendingToken = null;

  /** @param {AbortSignal | undefined} deadline */
  const fetchToken = async (deadline) => {
    const res = await fetch(`${base}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
        audience: `${base}/api/v2/`,
      }),
      signal: signalFor(deadline),
    });
    if (!res.ok)
      throw new ManagementError(`management token request failed: ${res.status}`, res.status);
    const body = /** @type {{ access_token?: unknown, expires_in?: unknown }} */ (await res.json());
    if (typeof body.access_token !== 'string') throw new Error('management token missing');
    const ttl = typeof body.expires_in === 'number' ? body.expires_in : 0;
    // Give it back a minute early, so a cached token never expires mid-call.
    if (ttl > 120)
      cache?.set(TOKEN_CACHE_KEY, body.access_token, { expires_at: now() + (ttl - 60) * 1000 });
    return body.access_token;
  };

  // One token request at a time, shared by calls made together (both email lookups).
  /** @param {AbortSignal | undefined} deadline */
  const token = (deadline) => {
    const cached = cache?.get(TOKEN_CACHE_KEY)?.value;
    if (cached) return Promise.resolve(cached);
    if (!pendingToken) {
      const p = fetchToken(deadline);
      pendingToken = p;
      p.catch(() => {
        if (pendingToken === p) pendingToken = null;
      });
    }
    return pendingToken;
  };

  /**
   * Resolves to the response once it is ok; the caller reads the body only if it needs it.
   * A 401 means the cached token went bad (rotated secret, revoked grant): drop it and
   * try once more with a fresh one.
   *
   * @param {string} path
   * @param {{ method?: string, body?: unknown, deadline?: AbortSignal | undefined }} [init]
   * @returns {Promise<{ ok: boolean, status: number, json: () => Promise<unknown> }>}
   */
  const call = async (path, init = {}, retried = false) => {
    const method = init.method ?? 'GET';
    const bearer = await token(init.deadline);
    const res = await fetch(`${base}/api/v2${path}`, {
      method,
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
      signal: signalFor(init.deadline),
    });
    if (res.status === 401 && !retried && !init.deadline?.aborted) {
      cache?.delete?.(TOKEN_CACHE_KEY);
      pendingToken = null;
      return call(path, init, true);
    }
    if (!res.ok)
      throw new ManagementError(`management API ${method} failed: ${res.status}`, res.status);
    return res;
  };

  /** @param {string} email @param {AbortSignal | undefined} deadline */
  const lookup = async (email, deadline) => {
    const res = await call(`/users-by-email?email=${encodeURIComponent(email)}`, { deadline });
    const users = await res.json();
    return Array.isArray(users) ? /** @type {User[]} */ (users) : [];
  };

  return {
    // users-by-email matches case-sensitively, and social connections keep the provider's
    // casing, so ask for the address as given and in lower case.
    async usersByEmail(email, deadline) {
      const forms = [...new Set([email, email.toLowerCase()])];
      const byId = new Map();
      for (const users of await Promise.all(forms.map((f) => lookup(f, deadline)))) {
        for (const u of users) if (!byId.has(u.user_id)) byId.set(u.user_id, u);
      }
      return [...byId.values()];
    },
    async link(primaryUserId, secondary, deadline) {
      await call(`/users/${encodeURIComponent(primaryUserId)}/identities`, {
        method: 'POST',
        body: secondary,
        deadline,
      });
    },
  };
}

// 400/409 from the link call: most likely another first login with the same email linked or
// created a user a moment ago, so the picture is stale. Look again once.
const isStale = (/** @type {unknown} */ e) =>
  e instanceof ManagementError && (e.status === 400 || e.status === 409);

/**
 * The Action's work, with the Management API and the log passed in (tests use fakes).
 *
 * @param {PostLoginEvent} event
 * @param {PostLoginApi} api
 * @param {{ management: Management | null, log: (...args: unknown[]) => void, deadlineMs?: number }} deps
 * @returns {Promise<string | null>} the primary user id it linked into, if any
 */
async function linkAccounts(event, api, { management, log, deadlineMs = DEADLINE_MS }) {
  const user = event.user;
  const email = user.email;
  // A refresh-token exchange already carries the user the login settled on.
  if (isRefresh(event)) return null;
  // Only a user with a single identity is linked into another. One that already has
  // linked identities is a primary itself; merging two primaries is left to the operator.
  const identities = user.identities ?? [];
  const identity = identities[0];
  if (identities.length !== 1 || !identity) return null;
  if (!email || !hasTrustedIdentity(user, email)) return null;
  if (!management) {
    log(LOG, 'not configured: set AUTH0_DOMAIN, MGMT_CLIENT_ID and MGMT_CLIENT_SECRET');
    return null;
  }
  const secondary = { provider: identity.provider, user_id: String(identity.user_id) };
  const deadline = AbortSignal.timeout(deadlineMs);
  // Every call carries the deadline; the race also ends a step that ignores it.
  /** @type {Promise<never>} */
  const expired = new Promise((_, reject) => {
    deadline.addEventListener('abort', () => reject(new Error('deadline')), { once: true });
  });
  expired.catch(() => {});

  const run = async () => {
    for (let attempt = 0; ; attempt++) {
      const found = await management.usersByEmail(email, deadline);
      const primary = choosePrimary(user, found);
      if (!primary) return null;
      try {
        await management.link(primary, secondary, deadline);
      } catch (e) {
        if (attempt === 0 && isStale(e) && !deadline.aborted) continue;
        throw e;
      }
      // Once linked, the current user no longer exists on its own: the login must go on as
      // the primary, deadline or not. (A link aborted by the deadline that Auth0 still applied
      // can't be told apart from one it never got; that login fails and the next one works.)
      api.authentication.setPrimaryUser(primary);
      // The token is the primary's now: its linked subs are the primary's, and this user.
      const primaryUser = found.find((u) => u.user_id === primary) ?? { user_id: primary };
      api.accessToken?.setCustomClaim(LINKED_SUBS_CLAIM, linkedSubsOf(primaryUser, [user.user_id]));
      // Ids only, never the email. Panote data stored under the secondary id (signed in
      // before it was linked) stays there, and account deletion reaches it through
      // LINKED_SUBS_CLAIM: docs/deploy.md, "Account linking".
      log(LOG, `linked ${user.user_id} into ${primary}`);
      return primary;
    }
  };

  const work = run();
  work.catch(() => {}); // after the deadline wins the race, a late failure must not go unhandled
  try {
    return await Promise.race([work, expired]);
  } catch (e) {
    if (deadline.aborted) {
      log(LOG, `linking timed out after ${deadlineMs} ms, signing in unlinked`);
    } else {
      log(LOG, 'linking failed, signing in unlinked:', e instanceof Error ? e.message : String(e));
    }
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
  const linkedInto = await linkAccounts(event, api, {
    management: managementFromSecrets(event, api),
    log,
  });
  // Linking set the primary's linked subs itself; otherwise they are this user's.
  if (!linkedInto) api.accessToken?.setCustomClaim(LINKED_SUBS_CLAIM, linkedSubsOf(event.user));
  const authTime = authTimeOf(event);
  if (authTime !== undefined) api.accessToken?.setCustomClaim(AUTH_TIME_CLAIM, authTime);
};

exports.TRUSTED_PROVIDERS = TRUSTED_PROVIDERS;
exports.AUTH_TIME_CLAIM = AUTH_TIME_CLAIM;
exports.LINKED_SUBS_CLAIM = LINKED_SUBS_CLAIM;
exports.MAX_LINKED_SUBS = MAX_LINKED_SUBS;
exports.authTimeOf = authTimeOf;
exports.linkedSubsOf = linkedSubsOf;
exports.DEADLINE_MS = DEADLINE_MS;
exports.ManagementError = ManagementError;
exports.choosePrimary = choosePrimary;
exports.linkAccounts = linkAccounts;
exports.managementClient = managementClient;
exports.managementFromSecrets = managementFromSecrets;
