import { authenticate } from '@internal/worker-kit';
import { createMiddleware } from 'hono/factory';

// The operator area (/api/admin/ops/*, and /app/ops in the admin app): signed-in Auth0 users
// whose sub hashes to one of OPERATOR_SUB_SHA256 (docs/deploy.md, "Operator pages"). Unlike
// the token-guarded /api/admin/operator/* routes the scripts call, these are for a person in
// a browser. The list holds hashes, not subs, so the repo never names anyone's Auth0 user.

const HASH_PATTERN = /^[0-9a-f]{64}$/;

/** The hex SHA-256 of a sub, as OPERATOR_SUB_SHA256 lists it. */
export const subHash = async (sub: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sub));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
};

/** The var's hashes: comma or whitespace separated, case-insensitive; anything else is dropped. */
export const parseOperatorHashes = (raw: string | undefined): Set<string> =>
  new Set(
    (raw ?? '')
      .split(/[\s,]+/)
      .map((h) => h.toLowerCase())
      .filter((h) => HASH_PATTERN.test(h)),
  );

/** Whether this sub is an operator here. An empty or unset list means nobody is. */
export const isOperatorSub = async (raw: string | undefined, sub: string): Promise<boolean> => {
  const hashes = parseOperatorHashes(raw);
  return hashes.size > 0 && hashes.has(await subHash(sub));
};

type GateEnv = {
  Bindings: Env;
  Variables: { sub: string | undefined };
};

/**
 * Every /api/admin/ops route. Runs after the /api/admin/* gate (which has already
 * authenticated and rate limited the caller); anyone who isn't an operator gets the same
 * plain 404 as a route that doesn't exist, so the area doesn't announce itself.
 */
export const requireOperator = createMiddleware<GateEnv>(async (c, next) => {
  const sub = c.get('sub') ?? (await authenticate(c.req.raw, c.env)).sub;
  if (!(await isOperatorSub(c.env.OPERATOR_SUB_SHA256, sub))) {
    return c.json({ error: 'not found' }, 404);
  }
  c.header('Cache-Control', 'private, no-store');
  await next();
});
