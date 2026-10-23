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

/** A verified identity: the token's `sub`, and the Panote claims the Auth0 Action adds. */
export interface AuthContext {
  readonly sub: string;
  /** Epoch seconds of the user's last actual sign-in; absent if the token doesn't say. */
  readonly authTime?: number;
  /** Identities linked into this user (see contracts' LINKED_SUBS_CLAIM). */
  readonly linkedSubs?: readonly string[];
  /** The user's verified email, lower case (contracts' EMAIL_CLAIM); absent if unverified. */
  readonly email?: string;
}

export type JwtVerifier = (token: string) => Promise<AuthContext>;
