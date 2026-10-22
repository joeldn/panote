// Share-link slugs (plan 3.2). Shared by admin-api and the share modal so
// both normalise and validate a slug the same way.

export const SLUG_MIN_LENGTH = 3;
export const SLUG_MAX_LENGTH = 40;
export const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;

export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  'api',
  'app',
  'admin',
  's',
  'embed',
  'new',
  'edit',
  'settings',
  'login',
  'logout',
  'callback',
  'auth',
  'privacy',
  'terms',
  'help',
  'docs',
  'static',
  'assets',
  'tiles',
  'pub',
  'slugs',
  'cdn',
  'www',
  'panote',
  // Brand, support and sign-in words a share link could impersonate.
  'support',
  'abuse',
  'security',
  'official',
  'staff',
  'contact',
  'account',
  'accounts',
  'billing',
  'password',
  'verify',
  'signin',
  'sign-in',
  'signup',
  'sign-up',
  'register',
  'google',
  'apple',
  'facebook',
  'microsoft',
]);

// Any slug starting with the brand name ("panote-team", "panotesupport").
const RESERVED_PREFIXES = ['panote'];
// A sign-in word as the whole slug or its first dash-separated part ("login-help"),
// but not a longer word that merely starts with one ("signing-day").
const RESERVED_FIRST_WORDS = ['login', 'log-in', 'signin', 'sign-in'];

/** Exact reservations, the brand prefix, and a sign-in word leading the slug. */
export const isReservedSlug = (slug: string): boolean =>
  RESERVED_SLUGS.has(slug) ||
  RESERVED_PREFIXES.some((p) => slug.startsWith(p)) ||
  RESERVED_FIRST_WORDS.some((w) => slug === w || slug.startsWith(`${w}-`));

/** Lowercase, `[^a-z0-9-]` to `-`, collapse repeated `-`, trim `-` at both ends. */
export const normalizeSlug = (raw: string): string =>
  raw
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');

export type SlugCheck = { ok: true } | { ok: false; reason: 'invalid' | 'reserved' };

export const checkSlug = (slug: string): SlugCheck => {
  if (!SLUG_PATTERN.test(slug)) return { ok: false, reason: 'invalid' };
  if (isReservedSlug(slug)) return { ok: false, reason: 'reserved' };
  return { ok: true };
};

export const isValidSlug = (slug: string): boolean => checkSlug(slug).ok;

const RANDOM_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
export const SLUG_RANDOM_LENGTH = 6;

export const randomSlugSuffix = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(SLUG_RANDOM_LENGTH));
  let out = '';
  for (const b of bytes) out += RANDOM_ALPHABET[b % RANDOM_ALPHABET.length];
  return out;
};

// Truncates `base` so `base + suffix` fits SLUG_MAX_LENGTH, without leaving
// a trailing `-` where the cut landed.
const withSuffix = (base: string, suffix: string): string =>
  `${base.slice(0, SLUG_MAX_LENGTH - suffix.length).replace(/-+$/, '')}${suffix}`;

// Claim order: slugify(title), `-2`..`-9`, then a random suffix; an
// unusable base (empty, too short, reserved) yields only `tour-<random>`.
export const defaultSlugCandidates = (
  title: string,
  random: () => string = randomSlugSuffix,
): string[] => {
  const base = withSuffix(normalizeSlug(title), '');
  if (!isValidSlug(base)) return [`tour-${random()}`];
  const candidates = [base];
  for (let n = 2; n <= 9; n += 1) candidates.push(withSuffix(base, `-${n}`));
  candidates.push(withSuffix(base, `-${random()}`));
  return candidates;
};
