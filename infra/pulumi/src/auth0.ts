import { readFileSync } from 'node:fs';

import * as auth0 from '@pulumi/auth0';
import * as pulumi from '@pulumi/pulumi';

import type { ResourceKey } from './names.js';
import { RESOURCES } from './names.js';
import type { Auth0Settings } from './settings.js';

/**
 * `packages/auth0-actions/src/`: the Actions' code, deployed as it is in the
 * repo (each file is the whole Action). Resolved from this module, so it is
 * the same from `src/` (tests) and `dist/` (the built program).
 */
const ACTIONS_DIR = new URL('../../../packages/auth0-actions/src/', import.meta.url);

/** The post-login Actions, in the order the Login flow runs them. */
export const POST_LOGIN_ACTIONS = [
  // First: a banned address is refused before it is linked into anything.
  { key: 'banListAction', file: 'ban-list.cjs', name: 'Block banned emails' },
  { key: 'linkAccountsAction', file: 'link-accounts.cjs', name: 'Link accounts by verified email' },
] as const satisfies readonly { key: ResourceKey; file: string; name: string }[];

/** What the link-accounts Action may do with the Management API, and nothing more. */
export const LINKING_SCOPES = ['read:users', 'update:users'];

/**
 * Every tenant is created with this password database. Panote never offers
 * passwords; `VITE_AUTH0_CONNECTIONS` only hides buttons, so the program
 * turns the database off for every application rather than trusting that.
 */
export const DATABASE_CONNECTION = 'Username-Password-Authentication';

/**
 * Refresh tokens: rotating, so a stolen one is caught on reuse, with Auth0's
 * defaults for the lifetimes (30 days absolute, 15 days idle). The apps keep
 * them in localStorage (docs/deploy.md, Sign-in).
 */
export const REFRESH_TOKEN = {
  rotationType: 'rotating',
  expirationType: 'expiring',
  leeway: 0,
  tokenLifetime: 30 * 24 * 60 * 60,
  idleTokenLifetime: 15 * 24 * 60 * 60,
  infiniteTokenLifetime: false,
  infiniteIdleTokenLifetime: false,
} as const;

/**
 * Attack Protection, at Auth0's default thresholds: brute-force lockout per
 * account and IP, and suspicious-IP throttling of logins and sign-ups.
 * Breached-password detection only matters if a password database is
 * ever turned on (whether a free tenant accepts it is unverified:
 * infra/README.md, step 15). Bot detection and CAPTCHA need a paid plan, so
 * they stay at the tenant's defaults.
 */
export const ATTACK_PROTECTION = {
  bruteForceProtection: {
    enabled: true,
    mode: 'count_per_identifier_and_ip',
    maxAttempts: 10,
    shields: ['block', 'user_notification'],
  },
  suspiciousIpThrottling: {
    enabled: true,
    shields: ['admin_notification', 'block'],
    // 100 failed logins per IP, refilling one every 14.4 min (a day for all of them).
    preLogin: { maxAttempts: 100, rate: 864000 },
    // 50 sign-ups per IP, refilling one every 1.2 s.
    preUserRegistration: { maxAttempts: 50, rate: 1200 },
  },
  breachedPasswordDetection: {
    enabled: true,
    method: 'standard',
    shields: ['admin_notification', 'block'],
    adminNotificationFrequencies: ['daily'],
    preUserRegistration: { shields: ['block'] },
  },
} as const;

/** The local Vite servers (docs/deploy.md, Local dev): admin on 5173, website on 5174. */
const LOCAL_ADMIN = 'http://localhost:5173';
const LOCAL_WEBSITE = 'http://localhost:5174';

const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * The `BANNED_EMAIL_SHA256` secret (docs/deploy.md, Email ban list), checked
 * and normalised: one comma-separated list of lower-case hashes, no
 * duplicates. Anything that isn't a hash fails the run, and only the count
 * is reported: a stray entry may be a pasted address, which must not end up
 * in a log.
 */
export function normaliseBanList(value: string): string {
  const entries = value
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((entry) => entry.toLowerCase());
  const bad = entries.filter((entry) => !SHA256_HEX.test(entry)).length;
  if (bad > 0) {
    throw new Error(
      `bannedEmailSha256: ${bad} entr${bad === 1 ? 'y is' : 'ies are'} not a SHA-256 hash (ban-email.cjs prints them)`,
    );
  }
  return [...new Set(entries)].join(',');
}

/**
 * The link-accounts Action's `MGMT_CLIENT_SECRET`. The provider reads a
 * client's secret back as an empty string when its own token lacks
 * `read:client_keys`; deploying that would quietly turn linking off, so it
 * stops the run instead.
 */
export function requireClientSecret(secret: string | undefined): string {
  if (!secret) {
    throw new Error(
      "the link-accounts client's secret came back empty: Pulumi's Auth0 token needs read:client_keys (infra/README.md)",
    );
  }
  return secret;
}

/**
 * The same at preview, which never deploys: the secret is whatever the state
 * holds, unchecked, so the CI preview client needs no `read:client_keys`
 * (infra/README.md, step 11). `up` still stops on an empty one.
 */
export function managementSecret(secret: string | undefined, dryRun: boolean): string {
  return dryRun ? (secret ?? '') : requireClientSecret(secret);
}

/** Values that live in the stack's config as secrets, never in the repo. */
export interface Auth0Secrets {
  /** The Google OAuth client's secret; only with `googleClientId`. */
  googleClientSecret?: pulumi.Input<string> | undefined;
  /** `BANNED_EMAIL_SHA256`; unset means nobody is refused. */
  bannedEmailSha256?: pulumi.Input<string> | undefined;
}

export interface Auth0Outputs {
  /** `VITE_AUTH0_CLIENT_ID` in both apps' `.env.<env>`. */
  spaClientId: pulumi.Output<string>;
  /** `OAUTH_ISSUER` in the APIs' `wrangler.jsonc`, trailing slash included. */
  issuer: string;
  /** `OAUTH_AUDIENCE` and `VITE_AUTH0_AUDIENCE`. */
  audience: string;
}

type Track = <T extends pulumi.CustomResource>(key: ResourceKey, resource: T) => T;

/**
 * Declares one environment's Auth0 tenant: the SPA both apps sign in with, the
 * API its tokens are for, the Google connection, Attack Protection, and the
 * two post-login Actions with the Management API client linking uses. The
 * tenant itself, its Pulumi client, and connections not listed here are made
 * by hand (infra/README.md).
 */
export function createAuth0(
  zone: string,
  settings: Auth0Settings,
  secrets: Auth0Secrets,
  track: Track,
): Auth0Outputs {
  const site = `https://${zone}`;
  const audience = `https://api.${zone}`;
  const local = settings.localDevCallbacks;

  // --- The API (resource server) ---------------------------------------------------
  track(
    'api',
    new auth0.ResourceServer(
      RESOURCES.api.name,
      {
        name: 'Panote API',
        identifier: audience,
        signingAlg: 'RS256',
        // The SPA's refresh tokens (docs/deploy.md, Sign-in).
        allowOfflineAccess: true,
        skipConsentForVerifiableFirstPartyClients: true,
      },
      // Deleting it, or a new identifier (a replacement), would 401 every token.
      { protect: true },
    ),
  );

  // --- The SPA (apps/website and apps/admin share it) ------------------------------
  const spa = track(
    'spaClient',
    new auth0.Client(
      RESOURCES.spaClient.name,
      {
        name: 'Panote',
        appType: 'spa',
        isFirstParty: true,
        oidcConformant: true,
        grantTypes: ['authorization_code', 'refresh_token'],
        callbacks: [`${site}/app/callback`, ...(local ? [`${LOCAL_ADMIN}/app/callback`] : [])],
        allowedLogoutUrls: [
          `${site}/`,
          `${site}/app/`,
          ...(local ? [`${LOCAL_ADMIN}/app/`, `${LOCAL_WEBSITE}/`] : []),
        ],
        webOrigins: [site, ...(local ? [LOCAL_ADMIN] : [])],
        jwtConfiguration: { alg: 'RS256' },
        refreshToken: REFRESH_TOKEN,
      },
      // A replacement is a new client id, which every built app still names.
      { protect: true },
    ),
  );
  // A public client: PKCE, no secret.
  track(
    'spaCredentials',
    new auth0.ClientCredentials(RESOURCES.spaCredentials.name, {
      clientId: spa.clientId,
      authenticationMethod: 'none',
    }),
  );

  // --- Connections ---------------------------------------------------------------------
  const google = track(
    'googleConnection',
    new auth0.Connection(
      RESOURCES.googleConnection.name,
      {
        name: 'google-oauth2',
        strategy: 'google-oauth2',
        options: {
          // Basic profile and email only (docs/deploy.md, More sign-in options).
          scopes: ['email', 'profile'],
          ...(settings.googleClientId === undefined
            ? {}
            : { clientId: settings.googleClientId, clientSecret: secrets.googleClientSecret }),
        },
      },
      // Deleting a connection deletes every user who signed in through it.
      { protect: true },
    ),
  );
  // The full list: only Panote's SPA signs in with Google.
  track(
    'googleConnectionClients',
    new auth0.ConnectionClients(RESOURCES.googleConnectionClients.name, {
      connectionId: google.id,
      enabledClients: [spa.clientId],
    }),
  );
  track(
    'databaseConnectionClients',
    new auth0.ConnectionClients(RESOURCES.databaseConnectionClients.name, {
      connectionId: auth0.getConnectionOutput({ name: DATABASE_CONNECTION }).apply((c) => c.id),
      enabledClients: [],
    }),
  );

  track(
    'attackProtection',
    new auth0.AttackProtection(RESOURCES.attackProtection.name, {
      bruteForceProtection: {
        ...ATTACK_PROTECTION.bruteForceProtection,
        shields: [...ATTACK_PROTECTION.bruteForceProtection.shields],
      },
      suspiciousIpThrottling: {
        ...ATTACK_PROTECTION.suspiciousIpThrottling,
        shields: [...ATTACK_PROTECTION.suspiciousIpThrottling.shields],
      },
      breachedPasswordDetection: {
        ...ATTACK_PROTECTION.breachedPasswordDetection,
        shields: [...ATTACK_PROTECTION.breachedPasswordDetection.shields],
        adminNotificationFrequencies: [
          ...ATTACK_PROTECTION.breachedPasswordDetection.adminNotificationFrequencies,
        ],
        preUserRegistration: {
          shields: [...ATTACK_PROTECTION.breachedPasswordDetection.preUserRegistration.shields],
        },
      },
    }),
  );

  // --- The link-accounts Action's Management API client ------------------------------
  const linking = track(
    'linkingClient',
    new auth0.Client(RESOURCES.linkingClient.name, {
      name: 'link-accounts action',
      description: 'Used only by the "Link accounts by verified email" Action (infra/pulumi)',
      appType: 'non_interactive',
      grantTypes: ['client_credentials'],
    }),
  );
  const linkingCredentials = track(
    'linkingCredentials',
    new auth0.ClientCredentials(RESOURCES.linkingCredentials.name, {
      clientId: linking.clientId,
      authenticationMethod: 'client_secret_post',
    }),
  );
  // The Management API only. Never Panote's own API: such a token stands for
  // no user (docs/deploy.md, Account linking).
  track(
    'linkingGrant',
    new auth0.ClientGrant(RESOURCES.linkingGrant.name, {
      clientId: linking.clientId,
      audience: `https://${settings.domain}/api/v2/`,
      scopes: LINKING_SCOPES,
    }),
  );

  // --- The post-login Actions, from packages/auth0-actions -----------------------------
  const banned = pulumi.output(secrets.bannedEmailSha256 ?? '').apply(normaliseBanList);
  const actionSecrets: Record<
    (typeof POST_LOGIN_ACTIONS)[number]['key'],
    auth0.ActionArgs['secrets']
  > = {
    // Missing means nobody is refused, as an empty secret would.
    banListAction: banned.apply((list) =>
      list ? [{ name: 'BANNED_EMAIL_SHA256', value: list }] : [],
    ),
    linkAccountsAction: [
      { name: 'AUTH0_DOMAIN', value: settings.domain },
      { name: 'MGMT_CLIENT_ID', value: linking.clientId },
      {
        name: 'MGMT_CLIENT_SECRET',
        value: pulumi.secret(
          linkingCredentials.clientSecret.apply((secret) =>
            managementSecret(secret, pulumi.runtime.isDryRun()),
          ),
        ),
      },
    ],
  };
  const actions = POST_LOGIN_ACTIONS.map(({ key, file, name }) => ({
    name,
    action: track(
      key,
      new auth0.Action(RESOURCES[key].name, {
        name,
        runtime: 'node22',
        supportedTriggers: { id: 'post-login', version: 'v3' },
        code: readFileSync(new URL(file, ACTIONS_DIR), 'utf8'),
        secrets: actionSecrets[key],
        deploy: true,
      }),
    ),
  }));
  // The whole Login flow, in order: an Action bound by hand is unbound by the next up.
  track(
    'postLoginActions',
    new auth0.TriggerActions(RESOURCES.postLoginActions.name, {
      trigger: 'post-login',
      actions: actions.map(({ name, action }) => ({ id: action.id, displayName: name })),
    }),
  );

  return { spaClientId: spa.clientId, issuer: `https://${settings.domain}/`, audience };
}
