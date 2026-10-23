import { z } from 'zod';

export interface Jwk {
  kid: string;
  n: string;
  e: string;
  kty: string;
  alg?: string | undefined;
}

// Deliberately loose: only the fields verifyJwt actually reads (see
// crypto.subtle.importKey below) are required. Unknown fields (e.g. `use`,
// `x5c`) are stripped, not rejected -- this is shape validation for a
// downstream failure to be clear, not a strict schema for the JWKS spec.
const JwkResponseSchema = z.object({
  kid: z.string(),
  n: z.string(),
  e: z.string(),
  kty: z.string(),
  alg: z.string().optional(),
});
const JwksResponseSchema = z.object({ keys: z.array(JwkResponseSchema) });

/**
 * Default timeout for the JWKS network fetch. Chosen to comfortably cover a
 * slow-but-healthy issuer round trip while still bounding how long a hung
 * issuer endpoint can stall a Worker request; overridable per call.
 */
export const DEFAULT_JWKS_TIMEOUT_MS = 5_000;
interface Claims {
  sub: string;
  iss: string;
  aud: string | string[];
  exp: number;
  /** Auth0's grant type; `client-credentials` on a machine-to-machine token. */
  gty?: unknown;
  [claim: string]: unknown;
}

/**
 * Custom claims the Auth0 post-login Action adds to the access token
 * (packages/auth0-actions/src/link-accounts.cjs keeps its own copy of these names).
 * Auth0 drops a custom claim that isn't namespaced with a URL.
 */
export const AUTH_TIME_CLAIM = 'https://panote.io/auth_time';
export const LINKED_SUBS_CLAIM = 'https://panote.io/linked_subs';
/** The user's address, lower case; the Action sets it only when a trusted provider verified it. */
export const EMAIL_CLAIM = 'https://panote.io/email';
/** At most this many linked subs are read from the token; the Action sends no more. */
export const MAX_LINKED_SUBS = 10;
// An Auth0 user id: `<provider>|<id>`, no whitespace, bounded.
const LINKED_SUB = /^[^\s|]+\|\S+$/;
const MAX_SUB_LENGTH = 256;

/** What a verified access token says about its user. */
export interface VerifiedClaims {
  sub: string;
  /** When the user last actually signed in (epoch seconds), from AUTH_TIME_CLAIM. */
  authTime?: number;
  /**
   * The user ids of identities linked into this user (link-accounts Action): data
   * made under one of them before it was linked is this user's too.
   */
  linkedSubs?: readonly string[];
  /** The user's verified email, lower case, from EMAIL_CLAIM. */
  email?: string;
}

const readAuthTime = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined;

const readLinkedSubs = (v: unknown, sub: string): string[] | undefined => {
  if (!Array.isArray(v)) return undefined;
  const subs = v.filter(
    (s): s is string =>
      typeof s === 'string' && s.length <= MAX_SUB_LENGTH && LINKED_SUB.test(s) && s !== sub,
  );
  return [...new Set(subs)].slice(0, MAX_LINKED_SUBS);
};

// Loose on purpose: the Action decides what is verified, this only refuses junk.
const MAX_EMAIL_LENGTH = 254;
const readEmail = (v: unknown): string | undefined =>
  typeof v === 'string' &&
  v.length <= MAX_EMAIL_LENGTH &&
  v === v.trim().toLowerCase() &&
  /^[^@\s]+@[^@\s]+$/.test(v)
    ? v
    : undefined;

const b64urlToBytes = (s: string): Uint8Array<ArrayBuffer> => {
  const pad = s.length % 4 ? '='.repeat(4 - (s.length % 4)) : '';
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

export const assertClaims = (
  c: Claims,
  opts: { issuer: string; audience: string },
): VerifiedClaims => {
  if (c.iss !== opts.issuer) throw new Error('bad issuer');
  const auds = Array.isArray(c.aud) ? c.aud : [c.aud];
  if (!auds.includes(opts.audience)) throw new Error('bad audience');
  // c is an unchecked cast from a JSON.parse'd payload (see verifyJwt below),
  // so a missing or non-numeric exp must fail closed here rather than let
  // `NaN <= Date.now()` (always false) treat the token as never expiring.
  if (typeof c.exp !== 'number' || !Number.isFinite(c.exp)) throw new Error('bad exp');
  if (c.exp * 1000 <= Date.now()) throw new Error('token expired');
  if (typeof c.sub !== 'string' || !c.sub) throw new Error('no subject');
  // A machine-to-machine (client-credentials) token is no user: refuse it even if an
  // M2M application is ever authorised for this API's audience.
  if (c.gty === 'client-credentials' || c.sub.endsWith('@clients')) {
    throw new Error('client-credentials token');
  }
  const authTime = readAuthTime(c[AUTH_TIME_CLAIM]);
  const linkedSubs = readLinkedSubs(c[LINKED_SUBS_CLAIM], c.sub);
  const email = readEmail(c[EMAIL_CLAIM]);
  return {
    sub: c.sub,
    ...(authTime !== undefined && { authTime }),
    ...(linkedSubs !== undefined && { linkedSubs }),
    ...(email !== undefined && { email }),
  };
};

export const fetchJwks = async (
  issuer: string,
  opts: { timeoutMs?: number | undefined } = {},
): Promise<Jwk[]> => {
  const base = issuer.replace(/\/?$/, '/');
  // AbortSignal.timeout() is a standard WHATWG API, not a Node- or
  // workerd-specific extension: it's implemented in both runtimes this
  // package ships to (workerd, and Node >=17.3 -- this repo requires
  // Node >=24), so it needs no extra AbortController plumbing to be valid on
  // either target, unlike e.g. Node's `fetch(url, { signal: AbortSignal... })`
  // support matrix for other timeout helpers.
  const res = await fetch(`${base}.well-known/jwks.json`, {
    signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_JWKS_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error('jwks fetch failed');
  const parsed = JwksResponseSchema.safeParse(await res.json());
  if (!parsed.success) {
    throw new Error(`jwks response has an unexpected shape: ${parsed.error.message}`);
  }
  return parsed.data.keys;
};

export const verifyJwt = async (
  token: string,
  opts: { issuer: string; audience: string; jwks: Jwk[] },
): Promise<VerifiedClaims> => {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('malformed jwt');
  const [h, p, s] = parts;
  if (!h || !p || !s) throw new Error('malformed jwt');
  const header = JSON.parse(new TextDecoder().decode(b64urlToBytes(h))) as {
    kid: string;
    alg: string;
  };
  if (header.alg !== 'RS256') throw new Error('unsupported alg');
  const jwk = opts.jwks.find((k) => k.kid === header.kid);
  if (!jwk) throw new Error('unknown kid');
  const key = await crypto.subtle.importKey(
    'jwk',
    { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true } as JsonWebKey,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const ok = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    b64urlToBytes(s),
    new TextEncoder().encode(`${h}.${p}`),
  );
  if (!ok) throw new Error('bad signature');
  return assertClaims(JSON.parse(new TextDecoder().decode(b64urlToBytes(p))) as Claims, opts);
};
