import type { JwtVerifier } from './env.js';

/**
 * Installs (or clears) the globalThis.__verifyJwt seam. The ONLY place in the
 * repo that knows that name. Test files call this from beforeAll; nothing else
 * may touch globalThis.__verifyJwt.
 */
export const setTestJwtVerifier = (verify: JwtVerifier | undefined): void => {
  globalThis.__verifyJwt = verify;
};
