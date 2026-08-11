import { Hono } from 'hono';
// public-api is "mostly anonymous", not "auth-free": POST /api/tours/:tourId/like
// is bi-modal (D1) - logged-in users dedupe by Auth0 sub via authenticateOptional,
// anonymous ones by an opaque X-Client-Id header. Do NOT remove this import as
// part of a later "public-api has no auth" cleanup - see port spec section 3.
import { authenticateOptional } from '@internal/worker-kit';
import { errorHandler } from '@internal/worker-kit/hono';

import { TourStats } from './stats.js';

const app = new Hono<{ Bindings: Env }>();

const stat = (c: { env: Env }, tourId: string) => c.env.STATS.get(c.env.STATS.idFromName(tourId));

app.post('/api/tours/:tourId/view', async (c) =>
  stat(c, c.req.param('tourId')).fetch('https://do/view', { method: 'POST' }),
);

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
