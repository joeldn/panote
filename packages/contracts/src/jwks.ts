import { fetchJwks, verifyJwt, type Jwk } from './jwt.js';

export interface JwksLoader {
  get(force?: boolean): Promise<Jwk[]>;
}

/**
 * Per-isolate JWKS cache with a TTL. Auth0's signing keys are stable for long
 * periods, so caching avoids a JWKS round-trip on every request; the TTL bounds
 * how long a *removed* key stays trusted. Key *rotation* (a new kid) is handled
 * by {@link verifyWithRotation}, not the TTL.
 */
export const makeJwksLoader = (issuer: string, ttlMs = 3_600_000): JwksLoader => {
  let keys: Jwk[] | null = null;
  let fetchedAt = 0;
  return {
    async get(force = false) {
      if (force || keys === null || Date.now() - fetchedAt > ttlMs) {
        keys = await fetchJwks(issuer);
        fetchedAt = Date.now();
      }
      return keys;
    },
  };
};

/**
 * Verify a JWT, transparently handling Auth0 signing-key rotation. If the
 * token's `kid` is absent from the cached JWKS, force a single refetch and
 * retry — otherwise a key added mid-TTL would 401 every request until the
 * isolate happened to recycle.
 */
export const verifyWithRotation = async (
  token: string,
  opts: { issuer: string; audience: string; loader: JwksLoader },
): Promise<{ sub: string }> => {
  const { issuer, audience, loader } = opts;
  try {
    return await verifyJwt(token, {
      issuer,
      audience,
      jwks: await loader.get(),
    });
  } catch (e) {
    if (e instanceof Error && e.message === 'unknown kid') {
      return await verifyJwt(token, {
        issuer,
        audience,
        jwks: await loader.get(true),
      });
    }
    throw e;
  }
};
