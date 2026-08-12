import { makeJwksLoader, verifyWithRotation, type JwksLoader } from '@internal/contracts';

import { bearerToken } from './bearer.js';
import { UnauthorizedError } from './errors.js';
import type { AuthContext, AuthEnv } from './env.js';

// One JWKS loader per isolate, exactly as both source Workers had. Each Worker
// bundles its own copy of this module, so this is per-Worker-per-isolate.
let jwks: JwksLoader | null = null;

export const authenticate = async (req: Request, env: AuthEnv): Promise<AuthContext> => {
  const bearer = bearerToken(req);
  if (!bearer) throw new UnauthorizedError();

  // READ AT CALL TIME. Hoisting this to module scope captures undefined, because
  // tests install the seam in beforeAll - i.e. after this module is imported -
  // and every authed test then silently falls through to the real JWKS path.
  // See the port spec section 0.8 before touching this line.
  const testVerify = globalThis.__verifyJwt;

  try {
    // The seam is a production auth backdoor unless it is explicitly opted into.
    // env.TEST_JWT_SEAM is never present in wrangler.jsonc (it is injected only
    // via the vitest pool's miniflare bindings), so this condition is always
    // false outside tests. See the port spec section 0.8.
    if (env.TEST_JWT_SEAM === 'enabled' && testVerify) return await testVerify(bearer);
    jwks ??= makeJwksLoader(env.OAUTH_ISSUER);
    return await verifyWithRotation(bearer, {
      issuer: env.OAUTH_ISSUER,
      audience: env.OAUTH_AUDIENCE,
      loader: jwks,
    });
  } catch (e) {
    console.warn('auth rejected:', e instanceof Error ? e.message : e);
    throw new UnauthorizedError();
  }
};

export const authenticateOptional = async (
  req: Request,
  env: AuthEnv,
): Promise<AuthContext | null> => {
  if (!bearerToken(req)) return null;
  try {
    return await authenticate(req, env);
  } catch {
    return null;
  }
};
