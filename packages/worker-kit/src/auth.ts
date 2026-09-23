import { makeJwksLoader, verifyWithRotation, type JwksLoader } from '@internal/contracts';

import { bearerToken } from './bearer.js';
import { UnauthorizedError } from './errors.js';
import type { AuthContext, AuthEnv } from './env.js';

// One JWKS loader per isolate, exactly as both source Workers had. Each Worker
// bundles its own copy of this module, so this is per-Worker-per-isolate.
let jwks: JwksLoader | null = null;

// Rejects a missing/empty/non-https/placeholder issuer up front, so
// misconfiguration fails loud instead of a per-request fetch to a dead
// host or an opaque URL-parse error. Nothing in code catches a placeholder
// renamed to drop "YOUR_", so it must only ever be replaced with the real tenant URL.
const isIssuerConfigured = (issuer: string): boolean => {
  if (!issuer || /YOUR_/i.test(issuer)) return false;
  try {
    return new URL(issuer).protocol === 'https:';
  } catch {
    return false;
  }
};

export const authenticate = async (req: Request, env: AuthEnv): Promise<AuthContext> => {
  const bearer = bearerToken(req);
  if (!bearer) throw new UnauthorizedError();

  // READ AT CALL TIME. Hoisting this to module scope captures undefined, because
  // tests install the seam in beforeAll - i.e. after this module is imported -
  // and every authed test then silently falls through to the real JWKS path.
  // See the port spec section 0.8 before touching this line.
  const testVerify = globalThis.__verifyJwt;

  // TEST_JWT_SEAM is only ever set by the vitest pool's miniflare bindings,
  // never in wrangler.jsonc, so this branch is inert in production. Its own
  // try/catch keeps it from skipping or interfering with the issuer guard
  // below.
  if (env.TEST_JWT_SEAM === 'enabled' && testVerify) {
    try {
      return await testVerify(bearer);
    } catch (e) {
      console.warn('auth rejected:', e instanceof Error ? e.message : e);
      throw new UnauthorizedError();
    }
  }

  // Checked before any network fetch and outside the try/catch below, so
  // this is the only rejection path for a bad issuer - never re-logged by
  // the generic catch. Every reason (missing, empty, non-https, placeholder)
  // 401s the same way; callers can't distinguish that from a bad token.
  if (!isIssuerConfigured(env.OAUTH_ISSUER)) {
    console.error(
      'OAUTH_ISSUER is unconfigured or a placeholder - all authenticated requests are rejected',
    );
    throw new UnauthorizedError();
  }

  try {
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

// With a bearer but an unconfigured issuer, authenticate() above logs once
// and throws; this treats that the same as anonymous rather than
// authenticated, so a misconfigured issuer never grants access.
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
