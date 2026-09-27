/** The admin SPA's base path; every other path on the host belongs to the website. */
export const ADMIN_BASE = '/app';

/** `vite dev` ports; the Auth0 dev SPA allows callbacks and logouts on these. */
export const DEV_ADMIN_ORIGIN = 'http://localhost:5173';
export const DEV_WEBSITE_ORIGIN = 'http://localhost:5174';

export interface AppOrigins {
  website: string;
  admin: string;
}

/** Deployed, both apps share `siteOrigin`; under `vite dev` they run on separate ports. */
export function appOrigins(siteOrigin: string, devServer: boolean): AppOrigins {
  if (devServer) return { website: DEV_WEBSITE_ORIGIN, admin: DEV_ADMIN_ORIGIN };
  const origin = new URL(siteOrigin).origin;
  return { website: origin, admin: origin };
}

/** The Auth0 redirect target for both apps. */
export const callbackUrl = (origins: AppOrigins): string =>
  `${origins.admin}${ADMIN_BASE}/callback`;

export const isAdminPath = (path: string): boolean =>
  path === ADMIN_BASE || /^\/app[/?#]/.test(path);

/**
 * Website path that opens the sign-in modal and comes back to `next` (path,
 * query and hash, e.g. `/app/new?resume=1`) once the user has signed in.
 */
export function signInPath(next?: string): string {
  const params = new URLSearchParams({ signin: '1' });
  if (next) params.set('next', next);
  return `/?${params.toString()}`;
}

export type ReturnTarget = { kind: 'admin'; path: string } | { kind: 'website'; url: string };

/**
 * Where a safe return path lands: an admin path becomes a router path under the
 * `/app` basename, anything else a full URL on the website's origin.
 */
export function returnTarget(path: string, origins: AppOrigins): ReturnTarget {
  if (isAdminPath(path)) {
    const rest = path.slice(ADMIN_BASE.length);
    return { kind: 'admin', path: rest.startsWith('/') ? rest : `/${rest}` };
  }
  return { kind: 'website', url: new URL(path, origins.website).href };
}
