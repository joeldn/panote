import {
  ExploreDecisionRequestSchema,
  EXPLORE_STALE_ERROR,
  explorePendingKey,
  ExplorePendingSchema,
  isContentId,
  REAUTH_REQUIRED_ERROR,
} from '@internal/contracts';
import { getJson } from '@internal/worker-kit/r2-binding';
import { Hono, type Context } from 'hono';

import { listApprovalQueue } from './explore.js';
import { jsonBody } from './limits.js';
import { by, staleSignIn, type SupportEnv } from './support.js';

// The operator's Explore approval queue (explore.ts), mounted at EXPLORE_QUEUE_PATH behind
// the operator gate: list the tours waiting, approve one (it is listed) or reject it (hidden
// from Explore, still live by link). Decisions need a recent sign-in, as the support writes.

const NO_STORE = 'private, no-store';

const publisher = (env: Env, tourId: string) => env.PUBLISHER.get(env.PUBLISHER.idFromName(tourId));

const queueNow = async (c: Context<SupportEnv>) => {
  c.header('Cache-Control', NO_STORE);
  return c.json({ tours: await listApprovalQueue(c.env.BUCKET) });
};

export const exploreQueueRoutes = new Hono<SupportEnv>();

exploreQueueRoutes.get('/', (c) => queueNow(c));

exploreQueueRoutes.post('/:tourId', async (c) => {
  if (staleSignIn(c)) return c.json({ error: REAUTH_REQUIRED_ERROR }, 403);
  const tourId = c.req.param('tourId');
  // Checked before it names an R2 key or a Durable Object.
  if (!isContentId(tourId)) return c.json({ error: 'tour not found' }, 404);
  const body = ExploreDecisionRequestSchema.safeParse(await jsonBody(c.req.raw));
  if (!body.success) return c.json({ error: body.error.format() }, 400);
  const { action, fingerprint } = body.data;
  // Only a tour still waiting, as the operator saw it: a reject of a tour that changed
  // since is refused like an approval, so the operator looks at what they're hiding.
  const got = await getJson<unknown>(c.env.BUCKET, explorePendingKey(tourId)).catch(() => null);
  const pending = got ? ExplorePendingSchema.safeParse(got.value) : null;
  if (!pending?.success || pending.data.fingerprint !== fingerprint) {
    return c.json({ error: EXPLORE_STALE_ERROR }, 409);
  }
  const stub = publisher(c.env, tourId);
  if (action === 'approve') {
    if ((await stub.approveExplore(tourId, fingerprint)) === 'stale') {
      return c.json({ error: EXPLORE_STALE_ERROR }, 409);
    }
  } else {
    await stub.rejectExplore(tourId);
  }
  console.warn(`[explore] operator ${action} of tour ${tourId} done ${await by(c)}`);
  return queueNow(c);
});
