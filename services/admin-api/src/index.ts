import {
  configKey,
  panoPrefix,
  SceneConfigSchema,
  TourDocSchema,
  tourKey,
  userPanosPrefix,
} from '@internal/contracts';
import { authenticate } from '@internal/worker-kit';
import { errorHandler } from '@internal/worker-kit/hono';
import { deletePrefix, listChildren, putJson } from '@internal/worker-kit/r2-binding';
import { Hono } from 'hono';

import { updateConditional } from './conditional.js';

const app = new Hono<{ Bindings: Env }>();

app.get('/api/admin/panos', async (c) => {
  const { sub } = await authenticate(c.req.raw, c.env);
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
  await deletePrefix(c.env.BUCKET, panoPrefix(sub, c.req.param('panoId')));
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
