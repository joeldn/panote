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
}

const b64urlToBytes = (s: string): Uint8Array<ArrayBuffer> => {
  const pad = s.length % 4 ? '='.repeat(4 - (s.length % 4)) : '';
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

export const assertClaims = (
  c: Claims,
  opts: { issuer: string; audience: string },
): { sub: string } => {
  if (c.iss !== opts.issuer) throw new Error('bad issuer');
  const auds = Array.isArray(c.aud) ? c.aud : [c.aud];
  if (!auds.includes(opts.audience)) throw new Error('bad audience');
  // c is an unchecked cast from a JSON.parse'd payload (see verifyJwt below),
  // so a missing or non-numeric exp must fail closed here rather than let
  // `NaN <= Date.now()` (always false) treat the token as never expiring.
  if (typeof c.exp !== 'number' || !Number.isFinite(c.exp)) throw new Error('bad exp');
  if (c.exp * 1000 <= Date.now()) throw new Error('token expired');
  if (!c.sub) throw new Error('no subject');
  return { sub: c.sub };
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
): Promise<{ sub: string }> => {
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
