/** The two vars every authed Worker declares. */
export interface AuthEnv {
  readonly OAUTH_ISSUER: string;
  readonly OAUTH_AUDIENCE: string;
  /**
   * Test-only opt-in for the globalThis.__verifyJwt seam. NEVER present in any
   * wrangler.jsonc - it is injected by the vitest pool's miniflare bindings.
   * Added in the seam-guard commit; absent until then.
   */
  readonly TEST_JWT_SEAM?: string | undefined;
}

/** The four values the aws4fetch S3 path needs. Two are wrangler secrets. */
export interface R2S3Env {
  readonly R2_ACCOUNT_ID: string;
  readonly R2_BUCKET: string;
  readonly R2_ACCESS_KEY_ID: string;
  readonly R2_SECRET_ACCESS_KEY: string;
}

/** A verified identity. Deliberately just `sub` - grow it when a second claim is read. */
export interface AuthContext {
  readonly sub: string;
}

export type JwtVerifier = (token: string) => Promise<AuthContext>;
