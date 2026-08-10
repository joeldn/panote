import { fetchJwks, verifyJwt, type Jwk } from './jwt.js';

export interface JwksLoader {
  get(force?: boolean): Promise<Jwk[]>;
}

/**
 * Per-isolate JWKS cache with a TTL. Auth0's signing keys are stable for long
 * periods, so caching avoids a JWKS round-trip on every request; the TTL bounds
 * how long a *removed* key stays trusted. Key *rotation* (a new kid) is handled
 * by {@link verifyWithRotation}, not the TTL.
 *
 * A forced refetch (`get(true)`) is triggered by {@link verifyWithRotation} on
 * an unknown `kid` taken from the *unverified* JWT header, before any
 * signature check — so it needs no valid signature to reach. Without a floor,
 * a stream of tokens with random `kid`s would force one outbound JWKS fetch
 * per request. `minForceIntervalMs` bounds how often a forced refetch is
 * actually honoured, and concurrent callers within one isolate coalesce onto
 * a single in-flight fetch rather than each starting their own.
 */
export const makeJwksLoader = (
  issuer: string,
  ttlMs = 3_600_000,
  minForceIntervalMs = 60_000,
): JwksLoader => {
  let keys: Jwk[] | null = null;
  let fetchedAt = 0;
  let inflight: Promise<Jwk[]> | null = null;

  const refresh = async (): Promise<Jwk[]> => {
    inflight ??= fetchJwks(issuer)
      .then((fetched) => {
        keys = fetched;
        fetchedAt = Date.now();
        return fetched;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  };

  return {
    async get(force = false) {
      const stale = keys === null || Date.now() - fetchedAt > ttlMs;
      const forceDue = force && Date.now() - fetchedAt > minForceIntervalMs;
      if (stale || forceDue) return refresh();
      return keys!;
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
