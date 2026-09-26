import {
  configKey,
  deletingKey,
  MAX_TOUR_SCENES,
  originalKey,
  PANO_PATTERN,
  SceneConfigSchema,
  TourDocSchema,
  tourKey,
  userPanosPrefix,
  type SceneConfig,
  type TourConfigEntry,
  type TourDoc,
} from '@internal/contracts';
import { authenticate } from '@internal/worker-kit';
import { errorHandler } from '@internal/worker-kit/hono';
import { getJson, listChildren, putJson } from '@internal/worker-kit/r2-binding';
import { Hono } from 'hono';

import { conditionalGet, guardedPut, updateConditional } from './conditional.js';
import { deletePano } from './delete-pano.js';

// Every owner GET's Cache-Control, on both the 200/304 body and the
// 400/404 error bodies - none of this is CDN/edge-cacheable.
const NO_STORE = 'private, no-store';

const setEtagAndNoStore = (c: { header: (n: string, v: string) => void }, etag: string): void => {
  c.header('ETag', `"${etag}"`);
  c.header('Cache-Control', NO_STORE);
};

// Tells "being deleted" apart from "config never written" for the same
// missing config key, so the caller can render a different empty state.
const panoTombstoneStatus = async (
  bucket: R2Bucket,
  sub: string,
  panoId: string,
): Promise<{ deleting: boolean; hasOriginal: boolean }> => {
  const [tombstone, original] = await Promise.all([
    bucket.head(deletingKey(sub, panoId)),
    bucket.head(originalKey(sub, panoId)),
  ]);
  return { deleting: !!tombstone, hasOriginal: !!original };
};

// The editor loads every scene config for a tour in one round trip; capped
// concurrency and a hard size cap keep that bounded regardless of scene count.
const CONFIG_FETCH_CONCURRENCY = 8;

const loadSceneConfigs = async (
  bucket: R2Bucket,
  sub: string,
  scenes: readonly { panoId: string }[],
): Promise<Record<string, TourConfigEntry>> => {
  const entries: Record<string, TourConfigEntry> = {};
  // Defence in depth: TourDocSchema already caps scenes at MAX_TOUR_SCENES,
  // but a legacy or hand-edited object could still exceed it.
  const panoIds = [...new Set(scenes.map((s) => s.panoId))].slice(0, MAX_TOUR_SCENES);
  for (let i = 0; i < panoIds.length; i += CONFIG_FETCH_CONCURRENCY) {
    const batch = panoIds.slice(i, i + CONFIG_FETCH_CONCURRENCY);
    await Promise.all(
      batch.map(async (panoId) => {
        const got = await getJson<SceneConfig>(bucket, configKey(sub, panoId));
        entries[panoId] = got
          ? { config: got.value, etag: got.etag }
          : { missing: true, ...(await panoTombstoneStatus(bucket, sub, panoId)) };
      }),
    );
  }
  return entries;
};

const app = new Hono<{ Bindings: Env }>();

app.get('/api/admin/panos', async (c) => {
  const { sub } = await authenticate(c.req.raw, c.env);
  // panoId segments are never encoded (unlike the owner segment), so
  // listChildren() needs no decode step to return what the caller passed in.
  const panoIds = await listChildren(c.env.BUCKET, userPanosPrefix(sub));
  return c.json({ panoIds });
});

app.get('/api/admin/panos/:panoId', async (c) => {
  const { sub } = await authenticate(c.req.raw, c.env);
  const panoId = c.req.param('panoId');
  if (!PANO_PATTERN.test(panoId)) {
    c.header('Cache-Control', NO_STORE);
    return c.json({ error: `panoId must match ${PANO_PATTERN}` }, 400);
  }
  const result = await conditionalGet(
    c.env.BUCKET,
    configKey(sub, panoId),
    c.req.header('If-None-Match'),
  );
  if (!result) {
    c.header('Cache-Control', NO_STORE);
    const status = await panoTombstoneStatus(c.env.BUCKET, sub, panoId);
    return c.json({ error: 'config not found', ...status }, 404);
  }
  setEtagAndNoStore(c, result.notModified ? result.etag : result.obj.etag);
  if (result.notModified) return c.body(null, 304);
  return c.json({ config: await result.obj.json<SceneConfig>(), etag: result.obj.etag });
});

app.put('/api/admin/panos/:panoId/config', async (c) => {
  const { sub } = await authenticate(c.req.raw, c.env);
  const panoId = c.req.param('panoId');
  const parsed = SceneConfigSchema.safeParse({
    ...((await c.req.json().catch(() => null)) ?? {}),
    panoId,
  });
  if (!parsed.success) return c.json({ error: parsed.error.format() }, 400);
  // 428 (missing If-Match) is checked before any state read, so it holds
  // regardless of whether a tombstone or the pano even exists.
  const onlyIf = updateConditional(c.req.header('If-Match'));
  // A tombstone means an interrupted DELETE is still in flight for this
  // panoId - refuse to resurrect it out from under that delete.
  if (await c.env.BUCKET.head(deletingKey(sub, panoId))) {
    return c.json({ error: 'pano is being deleted' }, 409);
  }
  const res = await putJson(c.env.BUCKET, configKey(sub, panoId), parsed.data, onlyIf);
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

app.get('/api/admin/tours/:tourId', async (c) => {
  const { sub } = await authenticate(c.req.raw, c.env);
  const tourId = c.req.param('tourId');
  if (!PANO_PATTERN.test(tourId)) {
    c.header('Cache-Control', NO_STORE);
    return c.json({ error: `tourId must match ${PANO_PATTERN}` }, 400);
  }
  const result = await conditionalGet(
    c.env.BUCKET,
    tourKey(sub, tourId),
    c.req.header('If-None-Match'),
  );
  if (!result) {
    c.header('Cache-Control', NO_STORE);
    return c.json({ error: 'not found' }, 404);
  }
  setEtagAndNoStore(c, result.notModified ? result.etag : result.obj.etag);
  if (result.notModified) return c.body(null, 304);
  const tour = await result.obj.json<TourDoc>();
  if (c.req.query('include') !== 'configs') return c.json({ tour, etag: result.obj.etag });
  const configs = await loadSceneConfigs(c.env.BUCKET, sub, tour.scenes);
  return c.json({ tour, etag: result.obj.etag, configs });
});

app.put('/api/admin/tours/:tourId', async (c) => {
  const { sub } = await authenticate(c.req.raw, c.env);
  const tourId = c.req.param('tourId');
  const parsed = TourDocSchema.safeParse({
    ...(await c.req.json().catch(() => ({}))),
    tourId,
  });
  if (!parsed.success) return c.json({ error: parsed.error.format() }, 400);
  // 428 before any state read, same reasoning as the config PUT above.
  const conditional = updateConditional(c.req.header('If-Match'));
  // PUT never creates a tour - tourIds only ever come from POST - so a
  // missing key here is "not found", not a create (guardedPut's 404).
  const result = await guardedPut(c.env.BUCKET, tourKey(sub, tourId), parsed.data, conditional);
  if (!result.ok) {
    return c.json({ error: result.status === 404 ? 'not found' : 'conflict' }, result.status);
  }
  return c.json({ etag: result.etag });
});

app.onError(errorHandler);

export default app;
