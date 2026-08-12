/**
 * Extracts a bearer token from an Authorization header. Returns null when the
 * header is absent or the token is empty.
 */
export const bearerToken = (req: Request): string | null =>
  req.headers.get('Authorization')?.replace(/^Bearer /, '') || null;
