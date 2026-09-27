import {
  AnalyticsContentIdSchema,
  AnalyticsEventBatchSchema,
  ViewBeaconSchema,
} from '@internal/contracts';
import { Hono } from 'hono';
// public-api is "mostly anonymous", not "auth-free": POST /api/tours/:tourId/like
// is bi-modal (D1) - logged-in users dedupe by Auth0 sub via authenticateOptional,
// anonymous ones by an opaque X-Client-Id header. Do NOT remove this import as
// part of a later "public-api has no auth" cleanup - see port spec section 3.
import { authenticateOptional } from '@internal/worker-kit';
import { errorHandler } from '@internal/worker-kit/hono';

import { readJsonBody, toDataPoint } from './events.js';
import { TourStats } from './stats.js';

const app = new Hono<{ Bindings: Env }>();

const stat = (c: { env: Env }, tourId: string) => c.env.STATS.get(c.env.STATS.idFromName(tourId));

// Every route keys a DO (and AE) by tourId, so reject junk ids before either
// is touched; otherwise any string would mint a new Durable Object.
app.use('/api/tours/:tourId/*', async (c, next) => {
  if (!AnalyticsContentIdSchema.safeParse(c.req.param('tourId')).success) {
    return c.json({ error: 'invalid tourId' }, 400);
  }
  await next();
});

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
  return stat(c, c.req.param('tourId')).fetch(`https://do/like?u=${encodeURIComponent(who)}`, {
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
