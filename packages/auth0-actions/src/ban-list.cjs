// @ts-check
'use strict';

/*
 * Auth0 post-login Action "Block banned emails".
 *
 * Paste this whole file into the Action's code editor (docs/deploy.md, "Email ban list"), and
 * put it FIRST in the Login flow, before "Link accounts by verified email", so a banned address
 * is refused before it is linked into anything.
 *
 * A takedown (services/admin-api/scripts/takedown.ts --disable-owner) blocks one Auth0 user id.
 * This blocks the person's email address instead, so a new Google, Apple or email-code sign-in
 * with that address can't start a fresh account. It needs no npm dependency.
 *
 * Secret (Action → Secrets):
 *   BANNED_EMAIL_SHA256  SHA-256 hashes (hex) of normalised email addresses, separated by
 *                        commas, spaces or newlines. Never the addresses themselves.
 *                        `node packages/auth0-actions/scripts/ban-email.cjs <email>` prints
 *                        the hash to add. Missing or empty: nobody is refused.
 *
 * Every address the user carries is checked: the root email and each linked identity's,
 * verified or not (an unverified address that matches still belongs to whoever was banned or
 * to someone posing as them; either way it doesn't sign in). It also runs on refresh-token
 * exchanges, so a session already open ends at its next token refresh.
 */

const LOG = '[ban-list]';

/** What the person sees on the admin app's callback page (it shows its own copy for access_denied). */
const DENY_REASON = 'This account can’t sign in to Panote.';

// Google ignores dots in the local part and treats googlemail.com as gmail.com.
const GMAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com']);

/**
 * The form an address is hashed in, so trivial variants of a banned address hash the same:
 * trimmed and lower-cased, any `+tag` dropped, and for Gmail the dots too.
 *
 * @param {string} email
 * @returns {string}
 */
function normaliseEmail(email) {
  const lower = email.trim().toLowerCase();
  const at = lower.lastIndexOf('@');
  if (at <= 0) return lower;
  let local = lower.slice(0, at);
  let domain = lower.slice(at + 1);
  const plus = local.indexOf('+');
  if (plus > 0) local = local.slice(0, plus);
  if (GMAIL_DOMAINS.has(domain)) {
    local = local.replace(/\./g, '');
    domain = 'gmail.com';
  }
  return `${local}@${domain}`;
}

/** @param {string} email @returns {Promise<string>} the hex SHA-256 of the normalised address */
async function emailHash(email) {
  const bytes = new TextEncoder().encode(normaliseEmail(email));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The hashes in the secret; anything that isn't 64 hex digits is ignored.
 *
 * @param {string | undefined} secret
 * @returns {Set<string>}
 */
function parseBanList(secret) {
  return new Set(
    (secret ?? '')
      .split(/[\s,]+/)
      .map((h) => h.toLowerCase())
      .filter((h) => /^[0-9a-f]{64}$/.test(h)),
  );
}

/**
 * @typedef {object} BanEvent
 * @property {{ email?: string, identities?: { profileData?: { email?: string } }[] }} user
 * @property {Record<string, string | undefined>} [secrets]
 */

/**
 * Every address on the user: the root email and each identity's.
 *
 * @param {BanEvent['user']} user
 * @returns {string[]}
 */
function emailsOf(user) {
  const all = [user.email, ...(user.identities ?? []).map((id) => id.profileData?.email)];
  return all.filter(/** @returns {e is string} */ (e) => typeof e === 'string' && e.includes('@'));
}

/**
 * @param {BanEvent} event
 * @returns {Promise<boolean>}
 */
async function isBanned(event) {
  const banned = parseBanList(event.secrets?.BANNED_EMAIL_SHA256);
  if (banned.size === 0) return false;
  const hashes = await Promise.all(emailsOf(event.user).map(emailHash));
  return hashes.some((h) => banned.has(h));
}

/**
 * Auth0 calls this on every login and token refresh (Actions → Triggers → post-login).
 *
 * @param {BanEvent} event
 * @param {{ access: { deny: (reason: string) => void } }} api
 */
exports.onExecutePostLogin = async (event, api) => {
  if (!(await isBanned(event))) return;
  // Never the address or the user id: the log is enough to tell the ban worked.
  // eslint-disable-next-line no-console
  console.log(LOG, 'sign-in refused: the email is on the ban list');
  api.access.deny(DENY_REASON);
};

exports.DENY_REASON = DENY_REASON;
exports.emailHash = emailHash;
exports.emailsOf = emailsOf;
exports.isBanned = isBanned;
exports.normaliseEmail = normaliseEmail;
exports.parseBanList = parseBanList;
