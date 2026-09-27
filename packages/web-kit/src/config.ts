import { z } from 'zod';

/**
 * Sign-in connections the UI knows how to render. Only connections listed in
 * `VITE_AUTH0_CONNECTIONS` *and* here are shown (Wave 6: Google only, Q2).
 */
export const KNOWN_CONNECTIONS = {
  'google-oauth2': { label: 'Google', icon: 'fa-brands fa-google' },
  apple: { label: 'Apple', icon: 'fa-brands fa-apple' },
  facebook: { label: 'Facebook', icon: 'fa-brands fa-facebook' },
} as const;
export type ConnectionId = keyof typeof KNOWN_CONNECTIONS;

const isKnownConnection = (c: string): c is ConnectionId => Object.hasOwn(KNOWN_CONNECTIONS, c);

// A placeholder value (`YOUR_…`) is allowed to parse so a production build
// with no tenant yet still boots; `auth0.configured` is then false.
const PLACEHOLDER = /YOUR_/i;

const origin = z
  .string()
  .url()
  .transform((v) => v.replace(/\/+$/, ''));

// Always ends in exactly one '/', so `${cdnBase}tiles/` is safe to build.
const baseUrl = z
  .string()
  .url()
  .transform((v) => `${v.replace(/\/+$/, '')}/`);

const EnvSchema = z.object({
  VITE_SITE_ORIGIN: origin,
  VITE_CDN_BASE: baseUrl,
  // Empty means same-origin (`/api/...`), which is the deployed layout (D1).
  VITE_API_BASE: z
    .string()
    .optional()
    .refine((v) => !v || v.startsWith('/') || /^https?:\/\/[^/]/.test(v), {
      message: 'must be an absolute http(s) URL or a path starting with /',
    })
    .refine((v) => !v?.startsWith('//'), { message: 'must not be protocol-relative' })
    .transform((v) => (v ?? '').replace(/\/+$/, '')),
  VITE_AUTH0_DOMAIN: z
    .string()
    .min(1)
    .transform((v) => v.replace(/^https?:\/\//, '').replace(/\/+$/, '')),
  VITE_AUTH0_CLIENT_ID: z.string().min(1),
  VITE_AUTH0_AUDIENCE: z.string().min(1),
  VITE_AUTH0_CONNECTIONS: z
    .string()
    .optional()
    .transform((v) =>
      (v ?? 'google-oauth2')
        .split(',')
        .map((c) => c.trim())
        .filter(isKnownConnection),
    )
    .refine((c) => c.length > 0, { message: 'names no known sign-in connection' }),
  VITE_SHOWCASE_SLUG: z
    .string()
    .optional()
    .transform((v) => (v ? v : null)),
});

export interface AuthConfig {
  domain: string;
  clientId: string;
  audience: string;
  connections: ConnectionId[];
  /** False while any Auth0 value is still a `YOUR_…` placeholder. */
  configured: boolean;
}

export interface AppConfig {
  siteOrigin: string;
  /** CDN root with a trailing slash, e.g. `https://cdn.panote.dev/`. */
  cdnBase: string;
  /** API origin without a trailing slash; `''` for same-origin. */
  apiBase: string;
  auth0: AuthConfig;
  showcaseSlug: string | null;
}

export class ConfigError extends Error {
  constructor(readonly issues: string[]) {
    super(`invalid frontend config: ${issues.join('; ')}`);
    this.name = 'ConfigError';
  }
}

/**
 * Validate the app's Vite env at boot. Apps call `loadConfig(import.meta.env)`;
 * taking the env as an argument keeps this package free of Vite types.
 */
export function loadConfig(env: Record<string, unknown>): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`));
  }
  const e = parsed.data;
  const auth0Values = [e.VITE_AUTH0_DOMAIN, e.VITE_AUTH0_CLIENT_ID, e.VITE_AUTH0_AUDIENCE];
  return {
    siteOrigin: e.VITE_SITE_ORIGIN,
    cdnBase: e.VITE_CDN_BASE,
    apiBase: e.VITE_API_BASE,
    auth0: {
      domain: e.VITE_AUTH0_DOMAIN,
      clientId: e.VITE_AUTH0_CLIENT_ID,
      audience: e.VITE_AUTH0_AUDIENCE,
      connections: [...new Set(e.VITE_AUTH0_CONNECTIONS)],
      configured: !auth0Values.some((v) => PLACEHOLDER.test(v)),
    },
    showcaseSlug: e.VITE_SHOWCASE_SLUG,
  };
}

/** The viewer's `baseUrl` (`<cdn>/tiles/`, see docs/deploy.md). */
export const tilesBaseUrl = (config: Pick<AppConfig, 'cdnBase'>): string =>
  `${config.cdnBase}tiles/`;
