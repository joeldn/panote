import {
  configKey,
  PANO_PATTERN,
  SceneConfigSchema,
  TourDocSchema,
  tourKey,
  userPanosPrefix,
} from '@internal/contracts';
import { authenticate } from '@internal/worker-kit';
import { errorHandler } from '@internal/worker-kit/hono';
import { listChildren, putJson } from '@internal/worker-kit/r2-binding';
import { Hono } from 'hono';

import { updateConditional } from './conditional.js';
import { deletePano } from './delete-pano.js';

const app = new Hono<{ Bindings: Env }>();

app.get('/api/admin/panos', async (c) => {
  const { sub } = await authenticate(c.req.raw, c.env);
  // panoId segments are never encoded (unlike the owner segment), so
  // listChildren() needs no decode step to return what the caller passed in.
  const panoIds = await listChildren(c.env.BUCKET, userPanosPrefix(sub));
  return c.json({ panoIds });
});

app.put('/api/admin/panos/:panoId/config', async (c) => {
  const { sub } = await authenticate(c.req.raw, c.env);
  const parsed = SceneConfigSchema.safeParse({
    ...((await c.req.json().catch(() => null)) ?? {}),
    panoId: c.req.param('panoId'),
  });
  if (!parsed.success) return c.json({ error: parsed.error.format() }, 400);
  const res = await putJson(
    c.env.BUCKET,
    configKey(sub, c.req.param('panoId')),
    parsed.data,
    updateConditional(c.req.header('If-Match')),
  );
  return res.ok ? c.json({ etag: res.etag }) : c.json({ error: 'conflict' }, 412);
});

app.delete('/api/admin/panos/:panoId', async (c) => {
  const { sub } = await authenticate(c.req.raw, c.env);
  const panoId = c.req.param('panoId');
  // No body schema here, so check panoId directly or it throws a 500 below.
  if (!PANO_PATTERN.test(panoId)) {
    return c.json({ error: `panoId must match ${PANO_PATTERN}` }, 400);
  }
  await deletePano(c.env.BUCKET, sub, panoId);
  return c.body(null, 204);
});

app.post('/api/admin/tours', async (c) => {
  const { sub } = await authenticate(c.req.raw, c.env);
  const tourId = crypto.randomUUID();
  const parsed = TourDocSchema.safeParse({
    ...(await c.req.json().catch(() => ({}))),
    tourId,
  });
  if (!parsed.success) return c.json({ error: parsed.error.format() }, 400);
  await putJson(c.env.BUCKET, tourKey(sub, tourId), parsed.data, { etagDoesNotMatch: '*' });
  return c.json({ tourId }, 201);
});

app.put('/api/admin/tours/:tourId', async (c) => {
  const { sub } = await authenticate(c.req.raw, c.env);
  const parsed = TourDocSchema.safeParse({
    ...(await c.req.json().catch(() => ({}))),
    tourId: c.req.param('tourId'),
  });
  if (!parsed.success) return c.json({ error: parsed.error.format() }, 400);
  const res = await putJson(
    c.env.BUCKET,
    tourKey(sub, c.req.param('tourId')),
    parsed.data,
    updateConditional(c.req.header('If-Match')),
  );
  return res.ok ? c.json({ etag: res.etag }) : c.json({ error: 'conflict' }, 412);
});

app.onError(errorHandler);

export default app;
