import {
  ACCOUNT_DELETE_CONFIRMATION,
  AccountDeleteRequestSchema,
  checkSlug,
  configKey,
  deletingKey,
  MAX_TOUR_SCENES,
  MAX_TOURS_PER_OWNER,
  OPERATOR_RESTORE_PATH,
  OPERATOR_TAKEDOWN_PATH,
  OPERATOR_TOKEN_HEADER,
  OperatorRestoreRequestSchema,
  OperatorTakedownRequestSchema,
  originalKey,
  PANO_DELETE_CONFLICTS,
  PANO_PATTERN,
  PublishRequestSchema,
  REAUTH_REQUIRED_ERROR,
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
import { authenticate, rateLimit, type AuthContext } from '@internal/worker-kit';
import { errorHandler } from '@internal/worker-kit/hono';
import { getJson, listChildren, putJson } from '@internal/worker-kit/r2-binding';
import { Hono, type Context } from 'hono';

import { BACKUP_CRON, restoreFromBackup } from './backup.js';
import {
  conditionalGet,
  guardedPut,
  ifNoneMatchHits,
  tourIfMatch,
  tourViewEtag,
  updateConditional,
  writeConditional,
} from './conditional.js';
import {
  deleteAccount,
  isAccountDeleted,
  sweepAccountDeletions,
  type AccountDeps,
} from './delete-account.js';
import { deleteOwnedPano } from './delete-owned-pano.js';
import { deleteTour } from './delete-tour.js';
import { insightsRoute } from './insights.js';
import { isAccountDisabled, isOperator, recordTourOwner, tourExists } from './operator.js';
import { sweepPlans } from './plans.js';
import { readPublishRecord, sweepExpiredAliases } from './publish.js';
import { isRecentAuth, requiresRecentAuth } from './recent-auth.js';
import { checkTileGcStatus, runBackupThenTileGc } from './tile-gc.js';
import { purgeCdn, type CdnPurge } from './purge.js';
import { runDailyCron } from './cron-status.js';
import { referencedPanoIds } from './references.js';
import { TourPublisher } from './publisher.js';
import {
  configCustomMetadata,
  countTours,
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

// `sub` and `auth` are set by the write gate below, which has already verified the JWT.
type AppEnv = {
  Bindings: Env;
  Variables: { sub: string | undefined; auth?: AuthContext };
};

const app = new Hono<AppEnv>();

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const ACCOUNT_PATH = '/api/admin/account';
// The WRITE_LIMITER binding's `simple.period` (wrangler.jsonc), sent as the
// 429's Retry-After. The limit itself lives in wrangler.jsonc, per env.
export const WRITE_RATE_PERIOD_SECONDS = 60;

// Every write is rate limited per owner, before any R2 read. Once an account is
// marked for deletion it is read-only: no write may recreate what the delete is
// removing. The account route itself stays open for retries, and for a disabled
// owner too: they may still delete their own account. The operator routes have no
// Auth0 user; their own secret guards them.
app.use('/api/admin/*', async (c, next) => {
  if (!WRITE_METHODS.has(c.req.method)) return next();
  if (c.req.path === OPERATOR_TAKEDOWN_PATH || c.req.path === OPERATOR_RESTORE_PATH) return next();
  const auth = await authenticate(c.req.raw, c.env);
  const verified = auth.sub;
  const limited = await rateLimit(c.env.WRITE_LIMITER, verified, WRITE_RATE_PERIOD_SECONDS);
  if (limited) return limited;
  c.set('sub', verified);
  c.set('auth', auth);
  if (c.req.path === ACCOUNT_PATH) return next();
  const [deleted, disabled] = await Promise.all([
    isAccountDeleted(c.env.BUCKET, verified),
    isAccountDisabled(c.env.BUCKET, verified),
  ]);
  if (deleted) return c.json({ error: 'account deleted' }, 410);
  // Taken down by the operator (scripts/takedown.ts): reads only, like a deleted account.
  if (disabled) return c.json({ error: 'account disabled' }, 403);
  return next();
});

// The caller's sub: from the write gate when it ran, else verified here (reads).
const ownerOf = async (c: Context<AppEnv>): Promise<string> =>
  c.get('sub') ?? (await authenticate(c.req.raw, c.env)).sub;

// Runs after the response; purgeCdn never throws, so a failure can't turn a 204 into a 500.
const purgeLater = (
  c: { env: Env; executionCtx: { waitUntil: (p: Promise<unknown>) => void } },
  purge: CdnPurge,
): void => {
  c.executionCtx.waitUntil(purgeCdn(c.env, purge));
};

app.get('/api/admin/panos', async (c) => {
  const sub = await ownerOf(c);
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
  // Opt-in, since it reads every tour.json: one GET per tour, per page.
  if (c.req.query('include') === 'references') {
    const referenced = await referencedPanoIds(c.env.BUCKET, sub);
    return c.json({
      panoIds,
      panos: panos.map((p) => ({ ...p, referenced: referenced.has(p.panoId) })),
      cursor,
    });
  }
  return c.json({ panoIds, panos, cursor });
});

app.get('/api/admin/panos/:panoId', async (c) => {
  const sub = await ownerOf(c);
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
  const sub = await ownerOf(c);
  const panoId = c.req.param('panoId');
  const parsed = SceneConfigSchema.safeParse({
    ...((await c.req.json().catch(() => null)) ?? {}),
    panoId,
  });
  if (!parsed.success) return c.json({ error: parsed.error.format() }, 400);
  // 428 (no If-Match or If-None-Match) is checked before any state read, so it holds
  // regardless of whether a tombstone or the pano even exists. `If-None-Match: *` = create-only.
  const onlyIf = writeConditional(c.req.header('If-Match'), c.req.header('If-None-Match'));
  const [tombstone, original] = await Promise.all([
    c.env.BUCKET.head(deletingKey(sub, panoId)),
    c.env.BUCKET.head(originalKey(sub, panoId)),
  ]);
  // A tombstone means an interrupted DELETE is still in flight for this
  // panoId - refuse to resurrect it out from under that delete.
  if (tombstone) return c.json({ error: 'pano is being deleted' }, 409);
  // A config is only for a pano the caller uploaded: without an original under
  // their own prefix, only an existing config (a legacy config-only pano) may be
  // updated, never created, so a well-formed made-up panoId can't store anything.
  let guard = onlyIf;
  if (!original) {
    const existing = await c.env.BUCKET.head(configKey(sub, panoId));
    if (!existing) return c.json({ error: 'pano not found' }, 404);
    // If-Match: * on a config-only pano still only updates the config just seen.
    guard ??= { etagMatches: existing.etag };
  }
  const res = await putJson(
    c.env.BUCKET,
    configKey(sub, panoId),
    parsed.data,
    guard,
    configCustomMetadata(parsed.data),
  );
  return res.ok ? c.json({ etag: res.etag }) : c.json({ error: 'conflict' }, 412);
});

app.delete('/api/admin/panos/:panoId', async (c) => {
  const sub = await ownerOf(c);
  const panoId = c.req.param('panoId');
  // No body schema here, so check panoId directly or it throws a 500 below.
  if (!PANO_PATTERN.test(panoId)) {
    return c.json({ error: `panoId must match ${PANO_PATTERN}` }, 400);
  }
  const result = await deleteOwnedPano(c.env.BUCKET, sub, panoId);
  if (!result.ok) {
    return result.status === 404
      ? c.json({ error: 'not found' }, 404)
      : c.json({ error: PANO_DELETE_CONFLICTS[result.conflict] }, 409);
  }
  // Same purge tour delete batches for each pano it deletes.
  if (result.tilesDeleted) purgeLater(c, { prefixes: [tilesPrefix(panoId)], files: [] });
  return c.body(null, 204);
});

app.post('/api/admin/tours', async (c) => {
  const sub = await ownerOf(c);
  const tourId = crypto.randomUUID();
  const parsed = TourDocSchema.safeParse({
    ...(await c.req.json().catch(() => ({}))),
    tourId,
  });
  if (!parsed.success) return c.json({ error: parsed.error.format() }, 400);
  // Same shape as upload-api's quota refusals. A soft cap: concurrent creates can
  // each pass, which the write rate limit keeps small.
  if ((await countTours(c.env.BUCKET, sub, MAX_TOURS_PER_OWNER)) >= MAX_TOURS_PER_OWNER) {
    return c.json({ error: 'tour limit reached' }, 403);
  }
  await putJson(
    c.env.BUCKET,
    tourKey(sub, tourId),
    parsed.data,
    { etagDoesNotMatch: '*' },
    tourCustomMetadata(parsed.data),
  );
  await recordTourOwner(c.env.BUCKET, sub, tourId);
  return c.json({ tourId }, 201);
});

app.get('/api/admin/tours', async (c) => {
  const sub = await ownerOf(c);
  const query = parseListQuery(c);
  if ('error' in query) {
    c.header('Cache-Control', NO_STORE);
    return c.json({ error: query.error }, 400);
  }
  const { tours, cursor } = await listTourSummaries(c.env.BUCKET, sub, query.cursor, query.limit);
  return c.json({ tours, cursor });
});

app.get('/api/admin/tours/:tourId', async (c) => {
  const sub = await ownerOf(c);
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
  const sub = await ownerOf(c);
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
  // Plan images the tour stopped using (replaced or removed): best-effort, after the answer.
  c.executionCtx.waitUntil(
    sweepPlans(c.env.BUCKET, sub, tourId, Date.now())
      .then((files) => (files.length ? purgeCdn(c.env, { prefixes: [], files }) : undefined))
      .catch((e: unknown) => {
        console.error('plan sweep failed:', e instanceof Error ? e.name : 'unknown error');
      }),
  );
  return c.json({ etag: result.etag });
});

app.delete('/api/admin/tours/:tourId', async (c) => {
  const sub = await ownerOf(c);
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
  const sub = await ownerOf(c);
  const tourId = c.req.param('tourId');
  const idError = tourIdError(tourId);
  if (idError) return c.json({ error: idError }, 400);
  const body = PublishRequestSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!body.success) return c.json({ error: body.error.format() }, 400);
  const invalidSlug = body.data.slug !== undefined ? slugError(body.data.slug) : null;
  if (invalidSlug) return c.json({ error: invalidSlug }, 400);
  const out = await publisher(c.env, tourId).publish(sub, tourId, body.data);
  // Tours created before the owner pointer existed get one when they're (re)published.
  if (out.status < 300) await recordTourOwner(c.env.BUCKET, sub, tourId);
  return c.json(out.body, out.status);
});

app.put('/api/admin/tours/:tourId/slug', async (c) => {
  const sub = await ownerOf(c);
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
  const sub = await ownerOf(c);
  const tourId = c.req.param('tourId');
  const idError = tourIdError(tourId);
  if (idError) return c.json({ error: idError }, 400);
  const body = VisibilityPatchRequestSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!body.success) return c.json({ error: body.error.format() }, 400);
  const out = await publisher(c.env, tourId).setVisibility(sub, tourId, body.data.visibility);
  return c.json(out.body, out.status);
});

app.delete('/api/admin/tours/:tourId/publish', async (c) => {
  const sub = await ownerOf(c);
  const tourId = c.req.param('tourId');
  const idError = tourIdError(tourId);
  if (idError) return c.json({ error: idError }, 400);
  // The owner's "Stop sharing": the editor's later Saves leave it offline.
  const files = await publisher(c.env, tourId).unpublish(sub, tourId, true);
  purgeLater(c, { prefixes: [], files });
  return c.body(null, 204);
});

app.get('/api/admin/tours/:tourId/insights', (c) => insightsRoute(c, c.req.param('tourId')));

// What account delete needs from the rest of the Worker; the sweep uses it too.
const accountDeps = (env: Env): AccountDeps => ({
  bucket: env.BUCKET,
  unpublishTour: (sub, tourId) => publisher(env, tourId).unpublish(sub, tourId),
  clearStats: async (tourId) => {
    // public-api's TourStats, one per tourId (see its stats.ts for the protocol).
    const res = await env.STATS.get(env.STATS.idFromName(tourId)).fetch('https://do/', {
      method: 'DELETE',
    });
    if (!res.ok) throw new Error(`stats reset failed: ${res.status}`);
  },
});

app.delete(ACCOUNT_PATH, async (c) => {
  const auth = c.get('auth') ?? (await authenticate(c.req.raw, c.env));
  const body = AccountDeleteRequestSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!body.success) {
    return c.json({ error: `confirm must be "${ACCOUNT_DELETE_CONFIRMATION}"` }, 400);
  }
  // Step-up: a token alone (stolen, or left in a shared browser) can't delete the account;
  // the admin app signs the owner in again and retries (docs/deploy.md, "Account deletion").
  if (requiresRecentAuth(c.env) && !isRecentAuth(auth.authTime, Date.now())) {
    return c.json({ error: REAUTH_REQUIRED_ERROR }, 403);
  }
  const { status, purge } = await deleteAccount(
    accountDeps(c.env),
    auth.sub,
    new Date(),
    auth.linkedSubs,
  );
  purgeLater(c, purge);
  return c.json({ status }, status === 'deleted' ? 200 : 202);
});

// Operator takedown (scripts/takedown.ts): the same unpublish and tour delete an
// owner gets, CDN purge included, for a tour the operator names by owner and id.
// A wrong or missing token, or no OPERATOR_TOKEN in this env, is a plain 404.
app.post(OPERATOR_TAKEDOWN_PATH, async (c) => {
  if (!(await isOperator(c.env.OPERATOR_TOKEN, c.req.header(OPERATOR_TOKEN_HEADER)))) {
    return c.json({ error: 'not found' }, 404);
  }
  const body = OperatorTakedownRequestSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!body.success) return c.json({ error: body.error.format() }, 400);
  const { sub, tourId, action } = body.data;
  if (!(await tourExists(c.env.BUCKET, sub, tourId))) {
    return c.json({ error: 'tour not found' }, 404);
  }
  const stub = publisher(c.env, tourId);
  if (action === 'hide' || action === 'unhide') {
    // Explore only: the share link, bundle and slug stay as they are, so nothing to purge.
    if (!(await stub.setExploreHidden(sub, tourId, action === 'hide'))) {
      return c.json({ error: 'tour not found' }, 404);
    }
    console.warn(`[takedown] operator ${action} of tour ${tourId} on Explore done`);
    return c.json({ action, purged: 0 });
  }
  const purge =
    action === 'delete'
      ? await deleteTour(c.env.BUCKET, sub, tourId, () => stub.unpublish(sub, tourId))
      : { prefixes: [], files: await stub.unpublish(sub, tourId, true) };
  purgeLater(c, purge);
  // An audit line for the logs: what was done to which tour. Never the sub (reversible to the owner).
  console.warn(`[takedown] operator ${action} of tour ${tourId} done`);
  return c.json({ action, purged: purge.prefixes.length + purge.files.length });
});

// Operator restore (scripts/restore-backup.ts): copies keys back from a day's backup set,
// through the binding so each object's metadata comes back exactly. Same token as takedown.
app.post(OPERATOR_RESTORE_PATH, async (c) => {
  if (!(await isOperator(c.env.OPERATOR_TOKEN, c.req.header(OPERATOR_TOKEN_HEADER)))) {
    return c.json({ error: 'not found' }, 404);
  }
  const body = OperatorRestoreRequestSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!body.success) return c.json({ error: body.error.format() }, 400);
  const { date, keys, overwrite } = body.data;
  const out = await restoreFromBackup(c.env.BUCKET, date, keys, overwrite);
  // A share link or bundle that 404ed may be cached as such; the restored ones are purged.
  const files = out.restored.filter((k) => k.startsWith('pub/') || k.startsWith('slugs/'));
  purgeLater(c, { prefixes: [], files });
  // An audit line: counts only, keys carry the owner.
  console.warn(
    `[restore] operator restore from ${date}: ${out.restored.length} restored, ${out.existing.length} left as they are, ${out.missing.length} not in the set, ${out.refused.length} refused, ${out.failed.length} failed`,
  );
  return c.json(out);
});

app.onError(errorHandler);

export default {
  fetch: app.fetch,
  // Daily Cron Trigger: releases slug aliases past their expiresAt (Q6),
  // finishes (or re-sweeps) every account marked for deletion, and checks the
  // tile sweep has been finishing cleanly.
  // The backup has its own, more frequent cron (backup.ts), so it gets its own
  // invocation's subrequest budget and can resume a set the last run didn't finish.
  // The same invocation then deletes tile versions a re-tile superseded more than a
  // day ago, with what the backup left of that budget (tile-gc.ts; no purge: nothing
  // references their URLs any more, and edge copies age out on their own).
  // It returns before runDailyCron, so the 15-minute cron never runs the daily
  // tasks or records a daily cron run.
  // runDailyCron logs each task that throws and records the run for the health check.
  scheduled(controller, env, ctx) {
    const now = new Date(controller.scheduledTime);
    if (controller.cron === BACKUP_CRON) {
      ctx.waitUntil(runBackupThenTileGc(env.BUCKET, now));
      return;
    }
    ctx.waitUntil(
      runDailyCron(env.BUCKET, now, {
        'slug-aliases': () => sweepExpiredAliases(env.BUCKET, now),
        'account-deletions': () =>
          sweepAccountDeletions(accountDeps(env), now).then((p) => purgeCdn(env, p)),
        // The sweep runs every 15 minutes (below); this only checks it is still
        // finishing cleanly, so a failing sweep still shows in the daily status.
        'tile-gc': () => checkTileGcStatus(env.BUCKET, now),
      }),
    );
  },
} satisfies ExportedHandler<Env>;

export { TourPublisher };
