import {
  checkSlug,
  configKey,
  deletingKey,
  MAX_TOUR_SCENES,
  originalKey,
  PANO_PATTERN,
  PublishRequestSchema,
  SceneConfigSchema,
  SlugPutRequestSchema,
  tilesPrefix,
  TourDocSchema,
  tourKey,
  userPanosPrefix,
  VisibilityPatchRequestSchema,
  type SceneConfig,
  type TourConfigEntry,
  type TourDoc,
  type TourPublishState,
} from '@internal/contracts';
import { authenticate } from '@internal/worker-kit';
import { errorHandler } from '@internal/worker-kit/hono';
import { getJson, listChildren, putJson } from '@internal/worker-kit/r2-binding';
import { Hono } from 'hono';

import {
  conditionalGet,
  guardedPut,
  ifNoneMatchHits,
  tourIfMatch,
  tourViewEtag,
  updateConditional,
  writeConditional,
} from './conditional.js';
import { deletePano } from './delete-pano.js';
import { deleteTour } from './delete-tour.js';
import { insightsRoute } from './insights.js';
import { readPublishRecord, sweepExpiredAliases } from './publish.js';
import { purgeCdn, type CdnPurge } from './purge.js';
import { TourPublisher } from './publisher.js';
import {
  configCustomMetadata,
  listPanoSummaries,
  listTourSummaries,
  MAX_LIST_LIMIT,
  parseListLimit,
  summarizePano,
  tourCustomMetadata,
} from './lists.js';

// Every owner GET's Cache-Control, on both the 200/304 body and the
// 400/404 error bodies - none of this is CDN/edge-cacheable.
const NO_STORE = 'private, no-store';

// Shared ?cursor/?limit validation for both list routes: a cursor is an
// opaque id, so it's checked the same way a path param id would be.
const parseListQuery = (c: {
  req: { query: (n: string) => string | undefined };
}): { cursor: string | undefined; limit: number } | { error: string } => {
  const cursor = c.req.query('cursor');
  if (cursor !== undefined && !PANO_PATTERN.test(cursor)) {
    return { error: `cursor must match ${PANO_PATTERN}` };
  }
  const limit = parseListLimit(c.req.query('limit'));
  if (!limit.ok) return { error: `limit must be an integer between 1 and ${MAX_LIST_LIMIT}` };
  return { cursor, limit: limit.limit };
};

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

// Runs after the response; purgeCdn never throws, so a failure can't turn a 204 into a 500.
const purgeLater = (
  c: { env: Env; executionCtx: { waitUntil: (p: Promise<unknown>) => void } },
  purge: CdnPurge,
): void => {
  c.executionCtx.waitUntil(purgeCdn(c.env, purge));
};

app.get('/api/admin/panos', async (c) => {
  const { sub } = await authenticate(c.req.raw, c.env);
  const query = parseListQuery(c);
  if ('error' in query) {
    c.header('Cache-Control', NO_STORE);
    return c.json({ error: query.error }, 400);
  }
  // panoId segments are never encoded (unlike the owner segment), so
  // listChildren() needs no decode step to return what the caller passed in.
  const panoIds = await listChildren(c.env.BUCKET, userPanosPrefix(sub));
  // panoIds stays the full, unpaginated list for compatibility; cursor/limit
  // only bound how many of them get the more expensive per-pano summary.
  const { panos, cursor } = await listPanoSummaries(
    c.env.BUCKET,
    sub,
    panoIds,
    query.cursor,
    query.limit,
  );
  return c.json({ panoIds, panos, cursor });
});

app.get('/api/admin/panos/:panoId', async (c) => {
  const { sub } = await authenticate(c.req.raw, c.env);
  const panoId = c.req.param('panoId');
  if (!PANO_PATTERN.test(panoId)) {
    c.header('Cache-Control', NO_STORE);
    return c.json({ error: `panoId must match ${PANO_PATTERN}` }, 400);
  }
  // Cheap polling path (the upload chip's failure detection, every 15s):
  // skips reading config.json entirely, unlike the full GET below.
  if (c.req.query('status') === '1') {
    c.header('Cache-Control', NO_STORE);
    const { title: _title, ...panoStatus } = await summarizePano(c.env.BUCKET, sub, panoId);
    return c.json({ status: panoStatus });
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
  const { title: _title, ...panoStatus } = await summarizePano(c.env.BUCKET, sub, panoId);
  return c.json({
    config: await result.obj.json<SceneConfig>(),
    etag: result.obj.etag,
    status: panoStatus,
  });
});

app.put('/api/admin/panos/:panoId/config', async (c) => {
  const { sub } = await authenticate(c.req.raw, c.env);
  const panoId = c.req.param('panoId');
  const parsed = SceneConfigSchema.safeParse({
    ...((await c.req.json().catch(() => null)) ?? {}),
    panoId,
  });
  if (!parsed.success) return c.json({ error: parsed.error.format() }, 400);
  // 428 (no If-Match or If-None-Match) is checked before any state read, so it holds
  // regardless of whether a tombstone or the pano even exists. `If-None-Match: *` = create-only.
  const onlyIf = writeConditional(c.req.header('If-Match'), c.req.header('If-None-Match'));
  // A tombstone means an interrupted DELETE is still in flight for this
  // panoId - refuse to resurrect it out from under that delete.
  if (await c.env.BUCKET.head(deletingKey(sub, panoId))) {
    return c.json({ error: 'pano is being deleted' }, 409);
  }
  const res = await putJson(
    c.env.BUCKET,
    configKey(sub, panoId),
    parsed.data,
    onlyIf,
    configCustomMetadata(parsed.data),
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
  const { tilesDeleted } = await deletePano(c.env.BUCKET, sub, panoId);
  if (tilesDeleted) purgeLater(c, { prefixes: [tilesPrefix(panoId)], files: [] });
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
  await putJson(
    c.env.BUCKET,
    tourKey(sub, tourId),
    parsed.data,
    { etagDoesNotMatch: '*' },
    tourCustomMetadata(parsed.data),
  );
  return c.json({ tourId }, 201);
});

app.get('/api/admin/tours', async (c) => {
  const { sub } = await authenticate(c.req.raw, c.env);
  const query = parseListQuery(c);
  if ('error' in query) {
    c.header('Cache-Control', NO_STORE);
    return c.json({ error: query.error }, 400);
  }
  const { tours, cursor } = await listTourSummaries(c.env.BUCKET, sub, query.cursor, query.limit);
  return c.json({ tours, cursor });
});

app.get('/api/admin/tours/:tourId', async (c) => {
  const { sub } = await authenticate(c.req.raw, c.env);
  const tourId = c.req.param('tourId');
  if (!PANO_PATTERN.test(tourId)) {
    c.header('Cache-Control', NO_STORE);
    return c.json({ error: `tourId must match ${PANO_PATTERN}` }, 400);
  }
  const [obj, stored] = await Promise.all([
    c.env.BUCKET.get(tourKey(sub, tourId)),
    readPublishRecord(c.env.BUCKET, sub, tourId),
  ]);
  if (!obj) {
    c.header('Cache-Control', NO_STORE);
    return c.json({ error: 'not found' }, 404);
  }
  // Header ETag covers publish.json too; the body etag stays tour.json's for If-Match.
  const viewEtag = tourViewEtag(obj.etag, stored?.etag);
  setEtagAndNoStore(c, viewEtag);
  if (ifNoneMatchHits(c.req.header('If-None-Match'), viewEtag)) return c.body(null, 304);
  const tour = await obj.json<TourDoc>();
  const record = stored?.value;
  const publish: TourPublishState | null = record
    ? { slug: record.slug, visibility: record.visibility, publishedAt: record.publishedAt }
    : null;
  if (c.req.query('include') !== 'configs') {
    return c.json({ tour, etag: obj.etag, publish });
  }
  const configs = await loadSceneConfigs(c.env.BUCKET, sub, tour.scenes);
  return c.json({ tour, etag: obj.etag, publish, configs });
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
  const conditional = updateConditional(tourIfMatch(c.req.header('If-Match')));
  // PUT never creates a tour - tourIds only ever come from POST - so a
  // missing key here is "not found", not a create (guardedPut's 404).
  const result = await guardedPut(
    c.env.BUCKET,
    tourKey(sub, tourId),
    parsed.data,
    conditional,
    tourCustomMetadata(parsed.data),
  );
  if (!result.ok) {
    return c.json({ error: result.status === 404 ? 'not found' : 'conflict' }, result.status);
  }
  return c.json({ etag: result.etag });
});

app.delete('/api/admin/tours/:tourId', async (c) => {
  const { sub } = await authenticate(c.req.raw, c.env);
  const tourId = c.req.param('tourId');
  // No body schema here, so check tourId directly (same reasoning as the
  // pano DELETE above) or tourKey() throws a 500 below.
  if (!PANO_PATTERN.test(tourId)) {
    return c.json({ error: `tourId must match ${PANO_PATTERN}` }, 400);
  }
  const stub = publisher(c.env, tourId);
  purgeLater(c, await deleteTour(c.env.BUCKET, sub, tourId, () => stub.unpublish(sub, tourId)));
  return c.body(null, 204);
});

const tourIdError = (tourId: string): string | null =>
  PANO_PATTERN.test(tourId) ? null : `tourId must match ${PANO_PATTERN}`;

const slugError = (slug: string): string | null => {
  const check = checkSlug(slug);
  return check.ok ? null : `${check.reason} slug`;
};

// All publish-state changes for a tour go through its TourPublisher, one at a time.
const publisher = (env: Env, tourId: string) => env.PUBLISHER.get(env.PUBLISHER.idFromName(tourId));

app.post('/api/admin/tours/:tourId/publish', async (c) => {
  const { sub } = await authenticate(c.req.raw, c.env);
  const tourId = c.req.param('tourId');
  const idError = tourIdError(tourId);
  if (idError) return c.json({ error: idError }, 400);
  const body = PublishRequestSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!body.success) return c.json({ error: body.error.format() }, 400);
  const invalidSlug = body.data.slug !== undefined ? slugError(body.data.slug) : null;
  if (invalidSlug) return c.json({ error: invalidSlug }, 400);
  const out = await publisher(c.env, tourId).publish(sub, tourId, body.data);
  return c.json(out.body, out.status);
});

app.put('/api/admin/tours/:tourId/slug', async (c) => {
  const { sub } = await authenticate(c.req.raw, c.env);
  const tourId = c.req.param('tourId');
  const idError = tourIdError(tourId);
  if (idError) return c.json({ error: idError }, 400);
  const body = SlugPutRequestSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!body.success) return c.json({ error: body.error.format() }, 400);
  const invalidSlug = slugError(body.data.slug);
  if (invalidSlug) return c.json({ error: invalidSlug }, 400);
  const out = await publisher(c.env, tourId).rename(sub, tourId, body.data.slug);
  return c.json(out.body, out.status);
});

app.patch('/api/admin/tours/:tourId/visibility', async (c) => {
  const { sub } = await authenticate(c.req.raw, c.env);
  const tourId = c.req.param('tourId');
  const idError = tourIdError(tourId);
  if (idError) return c.json({ error: idError }, 400);
  const body = VisibilityPatchRequestSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!body.success) return c.json({ error: body.error.format() }, 400);
  const out = await publisher(c.env, tourId).setVisibility(sub, tourId, body.data.visibility);
  return c.json(out.body, out.status);
});

app.delete('/api/admin/tours/:tourId/publish', async (c) => {
  const { sub } = await authenticate(c.req.raw, c.env);
  const tourId = c.req.param('tourId');
  const idError = tourIdError(tourId);
  if (idError) return c.json({ error: idError }, 400);
  const files = await publisher(c.env, tourId).unpublish(sub, tourId);
  purgeLater(c, { prefixes: [], files });
  return c.body(null, 204);
});

app.get('/api/admin/tours/:tourId/insights', (c) => insightsRoute(c, c.req.param('tourId')));

app.onError(errorHandler);

export default {
  fetch: app.fetch,
  // Daily Cron Trigger: releases slug aliases past their expiresAt (Q6).
  scheduled(controller, env, ctx) {
    ctx.waitUntil(sweepExpiredAliases(env.BUCKET, new Date(controller.scheduledTime)));
  },
} satisfies ExportedHandler<Env>;

export { TourPublisher };
