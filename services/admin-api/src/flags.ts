import {
  FlagDismissRequestSchema,
  flagIdOf,
  FlagRecordSchema,
  FLAGS_PAGE_MAX,
  FLAGS_ROOT,
  REAUTH_REQUIRED_ERROR,
  type FlagList,
  type FlagRecord,
} from '@internal/contracts';
import { getJson } from '@internal/worker-kit/r2-binding';
import { Hono, type Context } from 'hono';

import { jsonBody } from './limits.js';
import { by, staleSignIn, type SupportEnv } from './support.js';

// The operator's review of visitors' flags (public-api flags.ts writes them), mounted at
// FLAGS_PATH behind the operator gate: the newest flags, and dismissing the ones dealt with.
// Acting on a tour (hide, unpublish, disable its owner) stays on the Users page.

const NO_STORE = 'private, no-store';

/** The newest flags, at most FLAGS_PAGE_MAX; `more` when older ones are left. */
export const listFlags = async (bucket: R2Bucket): Promise<FlagList> => {
  const page = await bucket.list({ prefix: FLAGS_ROOT, limit: FLAGS_PAGE_MAX });
  const read = await Promise.all(
    page.objects.map(async (o) => {
      const got = await getJson<unknown>(bucket, o.key).catch(() => null);
      const parsed = got ? FlagRecordSchema.safeParse(got.value) : null;
      return parsed?.success && parsed.data.flagId === flagIdOf(o.key) ? parsed.data : null;
    }),
  );
  return { flags: read.filter((f): f is FlagRecord => f !== null), more: page.truncated };
};

/**
 * Deletes the named flags. A flag's key carries its time, which the operator doesn't send,
 * so they are found in the newest page: the only ones the queue ever shows.
 */
const dismissFlags = async (bucket: R2Bucket, flagIds: string[]): Promise<number> => {
  const wanted = new Set(flagIds);
  const page = await bucket.list({ prefix: FLAGS_ROOT, limit: FLAGS_PAGE_MAX });
  const keys = page.objects.map((o) => o.key).filter((k) => wanted.has(flagIdOf(k) ?? ''));
  if (keys.length > 0) await bucket.delete(keys);
  return keys.length;
};

const listNow = async (c: Context<SupportEnv>) => {
  c.header('Cache-Control', NO_STORE);
  return c.json(await listFlags(c.env.BUCKET));
};

export const flagRoutes = new Hono<SupportEnv>();

flagRoutes.get('/', (c) => listNow(c));

flagRoutes.post('/dismiss', async (c) => {
  if (staleSignIn(c)) return c.json({ error: REAUTH_REQUIRED_ERROR }, 403);
  const body = FlagDismissRequestSchema.safeParse(await jsonBody(c.req.raw));
  if (!body.success) return c.json({ error: body.error.format() }, 400);
  const n = await dismissFlags(c.env.BUCKET, body.data.flagIds);
  console.warn(`[flags] operator dismissed ${n} flag(s) ${await by(c)}`);
  return listNow(c);
});
