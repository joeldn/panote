export interface Jwk {
  kid: string;
  n: string;
  e: string;
  kty: string;
  alg?: string;
}
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

export const fetchJwks = async (issuer: string): Promise<Jwk[]> => {
  const base = issuer.replace(/\/?$/, '/');
  const res = await fetch(`${base}.well-known/jwks.json`);
  if (!res.ok) throw new Error('jwks fetch failed');
  return ((await res.json()) as { keys: Jwk[] }).keys;
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
