import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { authenticate, authenticateOptional } from './auth.js';
import { UnauthorizedError } from './errors.js';
import { setTestJwtVerifier } from './testing.js';
import type { AuthEnv } from './env.js';

// TEST_JWT_SEAM: 'enabled' is the opt-in the seam-guard commit added - without
// it, authenticate() must ignore globalThis.__verifyJwt entirely. Most tests in
// this file exercise the seam itself, so they opt in here; the dedicated
// "backdoor" describe block below builds its own env without the flag.
const env: AuthEnv = {
  OAUTH_ISSUER: 'https://issuer.example/',
  OAUTH_AUDIENCE: 'https://api.example',
  TEST_JWT_SEAM: 'enabled',
};

const reqWithAuth = (value?: string): Request =>
  new Request(
    'https://example.com',
    value === undefined ? {} : { headers: { Authorization: value } },
  );

// setTestJwtVerifier is the ONLY way these tests reach globalThis.__verifyJwt -
// see @internal/worker-kit/testing and port spec section 0.8.
afterEach(() => {
  setTestJwtVerifier(undefined);
});

describe('authenticate', () => {
  it('resolves the verified identity when the seam is installed and a bearer token is present', async () => {
    setTestJwtVerifier(async () => ({ sub: 'auth0|me' }));
    await expect(authenticate(reqWithAuth('Bearer good'), env)).resolves.toEqual({
      sub: 'auth0|me',
    });
  });

  it('rejects with UnauthorizedError when there is no Authorization header', async () => {
    const promise = authenticate(reqWithAuth(), env);
    await expect(promise).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(promise).rejects.toMatchObject({ status: 401 });
  });

  it('rejects with UnauthorizedError, without leaking the underlying message, when the seam rejects the token', async () => {
    setTestJwtVerifier(async () => {
      throw new Error('seam says no');
    });
    const promise = authenticate(reqWithAuth('Bearer bad'), env);
    await expect(promise).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(promise).rejects.toMatchObject({ message: 'unauthorized' });
  });
});

describe('authenticateOptional', () => {
  it('resolves null, and does not throw, when there is no Authorization header', async () => {
    await expect(authenticateOptional(reqWithAuth(), env)).resolves.toBeNull();
  });

  it('resolves null when the seam rejects the token', async () => {
    setTestJwtVerifier(async () => {
      throw new Error('seam says no');
    });
    await expect(authenticateOptional(reqWithAuth('Bearer bad'), env)).resolves.toBeNull();
  });

  it('resolves the verified identity for a good token', async () => {
    setTestJwtVerifier(async () => ({ sub: 'auth0|me' }));
    await expect(authenticateOptional(reqWithAuth('Bearer good'), env)).resolves.toEqual({
      sub: 'auth0|me',
    });
  });
});

// The seam-timing regression test - mandatory per port spec section 2.6.
//
// auth.js is already imported at the top of this file (module scope has already
// run) by the time this describe block's beforeAll installs the seam. That is
// deliberately the same ordering the real Worker test suites use: the pool
// imports the Worker (which imports auth.ts) once, then each test file installs
// the seam in its own beforeAll. authenticate() must read globalThis.__verifyJwt
// INSIDE its function body, at call time, for this to work - a module-scope
// hoist (`const testVerify = globalThis.__verifyJwt` at the top of auth.ts)
// would capture `undefined` here, because that capture would have run before
// this beforeAll ever installed anything.
//
// If this test starts failing - specifically, if `authenticate` rejects with
// UnauthorizedError instead of resolving - someone hoisted the
// globalThis.__verifyJwt read out of authenticate()'s function body. See port
// spec section 0.8.
describe('the __verifyJwt seam is read at call time, not at module-import time', () => {
  beforeAll(() => {
    setTestJwtVerifier(async () => ({ sub: 'auth0|seam-timing' }));
  });

  it('honours a seam installed after auth.js was already imported', async () => {
    await expect(authenticate(reqWithAuth('Bearer good'), env)).resolves.toEqual({
      sub: 'auth0|seam-timing',
    });
  });
});

// The security-regression test for the backdoor guard - mandatory per port spec
// section 2.6 ("after commit 12 only"). Without env.TEST_JWT_SEAM === 'enabled',
// authenticate() must ignore globalThis.__verifyJwt entirely and fall through to
// real JWKS verification, even when a verifier that WOULD grant access is
// installed. This is deliberately the same env shape a real deployment has:
// TEST_JWT_SEAM is never set in any wrangler.jsonc.
describe('the __verifyJwt seam is inert without env.TEST_JWT_SEAM (backdoor guard)', () => {
  const envWithoutSeamOptIn: AuthEnv = {
    OAUTH_ISSUER: 'https://issuer.example/',
    OAUTH_AUDIENCE: 'https://api.example',
  };

  it('rejects, attempting real JWKS verification, even though a granting verifier is installed', async () => {
    setTestJwtVerifier(async () => ({ sub: 'auth0|should-never-be-returned' }));
    // The issuer above is unreachable in this test environment, so if the guard
    // is doing its job, this falls through to makeJwksLoader/verifyWithRotation,
    // that fetch fails, and the failure is mapped to UnauthorizedError - not to
    // the identity the installed seam would have handed back.
    const promise = authenticate(reqWithAuth('Bearer good'), envWithoutSeamOptIn);
    await expect(promise).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(promise).rejects.toMatchObject({ status: 401 });
  });
});
