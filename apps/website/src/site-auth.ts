import {
  callbackUrl,
  createAuth,
  type AppOrigins,
  type Auth,
  type Auth0Factory,
  type AuthConfig,
} from '@internal/web-kit';

/**
 * The site's `Auth`. The Auth0 SDK chunk only loads for a sign-in, or once this origin's
 * SDK cache (localStorage, shared with the admin app) has an entry, so anonymous visitors
 * of the landing page and /s/:slug never download it. The catch: an owner whose session
 * lives only on another origin or device is shown as signed out (no "Edit" on their tour)
 * until they sign in on this origin.
 */
export function createSiteAuth(
  config: AuthConfig,
  origins: AppOrigins,
  createClient?: Auth0Factory,
): Auth {
  return createAuth(config, {
    // The callback lives in the admin app, so returnTo paths resolve against its origin.
    redirectUri: callbackUrl(origins),
    crossOriginCallback: origins.website !== origins.admin,
    requireCachedSession: true,
    ...(createClient && { createClient }),
  });
}
