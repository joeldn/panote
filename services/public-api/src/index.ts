import {
  AnalyticsContentIdSchema,
  AnalyticsEventBatchSchema,
  CLIENT_ID_PATTERN,
  pubTourKey,
  ViewBeaconSchema,
} from '@internal/contracts';
import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
// public-api is "mostly anonymous", not "auth-free": POST /api/tours/:tourId/like
// is bi-modal (D1) - logged-in users dedupe by Auth0 sub via authenticateOptional,
// anonymous ones by an opaque X-Client-Id header. Do NOT remove this import as
// part of a later "public-api has no auth" cleanup - see port spec section 3.
import { authenticateOptional, rateLimit, type RateLimiter } from '@internal/worker-kit';
import { errorHandler } from '@internal/worker-kit/hono';

import { readJsonBody, toDataPoint } from './events.js';
import { TourStats } from './stats.js';

const app = new Hono<{ Bindings: Env }>();

const stat = (c: { env: Env }, tourId: string) => c.env.STATS.get(c.env.STATS.idFromName(tourId));

// Every limiter binding's `simple.period` (wrangler.jsonc), sent as the 429's
// Retry-After. The limits themselves live in wrangler.jsonc, per env.
export const RATE_PERIOD_SECONDS = 60;

// Per client IP. Cloudflare always sets CF-Connecting-IP in front of a Worker;
// without it (a test, a local dev request) every caller shares one key.
const limitByIp = (pick: (env: Env) => RateLimiter) =>
  createMiddleware<{ Bindings: Env }>(async (c, next) => {
    const ip = c.req.header('CF-Connecting-IP') ?? 'unknown';
    const limited = await rateLimit(pick(c.env), ip, RATE_PERIOD_SECONDS);
    if (limited) return limited;
    await next();
  });

// Every route keys a DO (and AE) by tourId, so reject junk ids before either
// is touched; otherwise any string would mint a new Durable Object.
app.use('/api/tours/:tourId/*', async (c, next) => {
  if (!AnalyticsContentIdSchema.safeParse(c.req.param('tourId')).success) {
    return c.json({ error: 'invalid tourId' }, 400);
  }
  await next();
});

// Rate limits, one per route, run before the handlers below.
app.post(
  '/api/tours/:tourId/view',
  limitByIp((env) => env.VIEW_LIMITER),
);
app.post(
  '/api/tours/:tourId/events',
  limitByIp((env) => env.EVENTS_LIMITER),
);
app.post(
  '/api/tours/:tourId/like',
  limitByIp((env) => env.LIKE_LIMITER),
);

app.post('/api/tours/:tourId/view', async (c) => {
  const body = await readJsonBody(c.req.raw);
  if (!body.ok) return c.json({ error: 'invalid body' }, body.status);
  const parsed = ViewBeaconSchema.safeParse(body.value);
  if (!parsed.success) return c.json({ error: 'invalid body' }, 400);
  const tourId = c.req.param('tourId');
  const res = await stat(c, tourId).fetch('https://do/view', { method: 'POST' });
  c.env.EVENTS.writeDataPoint(toDataPoint(tourId, { type: 'view', ...parsed.data }));
  return res;
});

app.post('/api/tours/:tourId/events', async (c) => {
  const body = await readJsonBody(c.req.raw);
  if (!body.ok) return c.json({ error: 'invalid body' }, body.status);
  const parsed = AnalyticsEventBatchSchema.safeParse(body.value);
  if (!parsed.success) return c.json({ error: 'invalid body' }, 400);
  const tourId = c.req.param('tourId');
  for (const event of parsed.data.events) c.env.EVENTS.writeDataPoint(toDataPoint(tourId, event));
  return c.body(null, 204);
});

app.post('/api/tours/:tourId/like', async (c) => {
  // Logged-in users dedupe by Auth0 sub; anonymous ones by an opaque client
  // token. authenticateOptional replaces the source's swallowed try/catch - same
  // behaviour, intent stated in the type rather than hidden in a bare `catch {}`.
  const identity = await authenticateOptional(c.req.raw, c.env);
  const who = identity?.sub ?? c.req.header('X-Client-Id') ?? null;
  // No identity -> no dedupe key; reject rather than silently dropping the like.
  if (!who) return c.json({ error: 'login or X-Client-Id required to like' }, 400);
  // Only the shape the website mints (a v4 UUID): a dedupe key is stored per id,
  // so free-form ids would let anyone fill the tour's storage with junk.
  if (!identity && !CLIENT_ID_PATTERN.test(who)) {
    return c.json({ error: 'invalid X-Client-Id' }, 400);
  }
  const tourId = c.req.param('tourId');
  // Only a published tour takes likes: a well-formed id for a tour that doesn't
  // exist must not mint a Durable Object or store anything.
  if (!(await c.env.BUCKET.head(pubTourKey(tourId)))) {
    return c.json({ error: 'tour not found' }, 404);
  }
  return stat(c, tourId).fetch(`https://do/like?u=${encodeURIComponent(who)}`, {
    method: 'POST',
  });
});

app.get('/api/tours/:tourId/stats', async (c) => {
  const res = await stat(c, c.req.param('tourId')).fetch('https://do/');
  return new Response(res.body, {
    headers: {
      'content-type': 'application/json',
      'cache-control': 'public, max-age=30',
    },
  });
});

app.onError(errorHandler);

export default app;
export { TourStats };
