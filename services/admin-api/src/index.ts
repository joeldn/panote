import {
  ACCOUNT_DELETE_CONFIRMATION,
  AccountDeleteRequestSchema,
  checkSlug,
  configKey,
  contentIdError,
  deletingKey,
  InviteAcceptRequestSchema,
  InviteCreateRequestSchema,
  isContentId,
  MAX_TOUR_SCENES,
  MAX_TOURS_PER_OWNER,
  OPERATOR_BACKFILL_PATH,
  OPERATOR_RESTORE_PATH,
  OPERATOR_TAKEDOWN_PATH,
  OPERATOR_TOKEN_HEADER,
  OperatorBackfillRequestSchema,
  OperatorRestoreRequestSchema,
  OperatorTakedownRequestSchema,
  originalKey,
  PANO_DELETE_CONFLICTS,
  PublishRequestSchema,
  REAUTH_REQUIRED_ERROR,
  SceneConfigSchema,
  signInOf,
  SlugPutRequestSchema,
  tilesPrefix,
  TourDocSchema,
  tourKey,
  tourOwnerKey,
  userPanosPrefix,
  VisibilityPatchRequestSchema,
  type AccountView,
  type CdnPurgeOutcome,
  type SceneConfig,
  type TourConfigEntry,
  type TourDoc,
  type TourPublishState,
} from '@internal/contracts';
import { authenticate, rateLimit, rateLimitKeyForIp, type AuthContext } from '@internal/worker-kit';
import { errorHandler } from '@internal/worker-kit/hono';
import { getJson, listChildren, putJson } from '@internal/worker-kit/r2-binding';
import { Hono, type Context } from 'hono';
import { createMiddleware } from 'hono/factory';

import { backfillTours } from './backfill.js';
import { BACKUP_CRON, BACKUP_RUN_BUDGET, restoreFromBackup } from './backup.js';
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
import {
  jsonBody,
  jsonObjectBody,
  MAX_CONFIG_BODY_BYTES,
  PANO_DELETE_RATE_PERIOD_SECONDS,
  WRITE_RATE_PERIOD_SECONDS,
} from './limits.js';
import {
  acceptInvite,
  createInvite,
  getMembers,
  isRefusal,
  listSharedTours,
  recordMembership,
  removeMember,
  revokeInvite,
  scenesEditorMayNotAdd,
  tourAccessFor,
  uploadedForTour,
  type AccessRefusal,
} from './members.js';
import { isAccountDisabled, isOperator, recordTourOwner, tourExists } from './operator.js';
import { sweepUnsavedPlans } from './plan-sweep.js';
import { sweepPlans } from './plans.js';
import { readPublishRecord, sweepExpiredAliases } from './publish.js';
import { isRecentAuth, requiresRecentAuth } from './recent-auth.js';
import { checkTileGcStatus, runBackupThenTileGc } from './tile-gc.js';
import { deleteFromTrash, restoreFromTrash, sweepTrash } from './trash.js';
import {
  meteredBucket,
  PENDING_RECORD_MAX_ITEMS,
  purgeCdn,
  RETRY_RUN_MAX_SUBREQUESTS,
  retryPendingPurges,
  type CdnPurge,
} from './purge.js';
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
  if (cursor !== undefined && !isContentId(cursor)) {
    return { error: contentIdError('cursor') };
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

// `sub` and `auth` are set by the gate below, which has already verified the JWT.
type AppEnv = {
  Bindings: Env;
  Variables: { sub: string | undefined; auth?: AuthContext };
};

const app = new Hono<AppEnv>();

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const OPERATOR_PATHS = new Set([
  OPERATOR_TAKEDOWN_PATH,
  OPERATOR_RESTORE_PATH,
  OPERATOR_BACKFILL_PATH,
]);
const READ_METHODS = new Set(['GET', 'HEAD']);
const ACCOUNT_PATH = '/api/admin/account';
export { PANO_DELETE_RATE_PERIOD_SECONDS, WRITE_RATE_PERIOD_SECONDS };
// The 15-minute cron's R2 budget once the purge retry has run first: the backup, the tile
// sweep and its status share it, so the invocation's total is BACKUP_RUN_BUDGET (900):
// RETRY_RUN_MAX_SUBREQUESTS (97) + 803.
export const FIFTEEN_MINUTE_RUN_OPS = BACKUP_RUN_BUDGET - RETRY_RUN_MAX_SUBREQUESTS;
// The operator takedown's purge before it answers: at most this many purge API requests
// (100 URLs each, retries included) and this long. The rest is queued for the cron, and
// the answer says so. Bounded so the request stays quick and leaves the invocation's
// subrequests for the tour delete's R2 calls and the queue writes.
export const OPERATOR_PURGE_MAX_REQUESTS = 100;
export const OPERATOR_PURGE_DEADLINE_MS = 20_000;
// The Workers Paid per-invocation subrequest limit this repo sizes against (backup.ts),
// and what the takedown keeps back from it besides the queue writes: the publisher calls,
// the failure marker and the dead letters, with slack.
const SUBREQUEST_LIMIT = 1_000;
const OPERATOR_ROUTE_RESERVE = 25;

// The operator routes have no Auth0 user; their own secret guards them. A per-IP limit
// (an IPv6 client per /64) runs first, so a wrong or missing token spends it too and the
// secret can't be guessed at speed. Cloudflare always sets CF-Connecting-IP in front of a
// Worker; without it (a test) every caller shares one key.
const operatorLimit = createMiddleware<AppEnv>(async (c, next) => {
  const ip = rateLimitKeyForIp(c.req.header('CF-Connecting-IP') ?? 'unknown');
  const limited = await rateLimit(c.env.OPERATOR_LIMITER, ip, WRITE_RATE_PERIOD_SECONDS);
  if (limited) return limited;
  await next();
});
app.use(OPERATOR_TAKEDOWN_PATH, operatorLimit);
app.use(OPERATOR_RESTORE_PATH, operatorLimit);
app.use(OPERATOR_BACKFILL_PATH, operatorLimit);

// Every read is rate limited per owner too, on its own budget, before any R2 read: a
// list costs R2 operations on every call, and nothing else would stop a loop on it.
// Insights has its own, tighter limit on top (insights.ts).
//
// Every write is rate limited per owner, before any R2 read. Once an account is
// marked for deletion it is read-only: no write may recreate what the delete is
// removing. The account route itself stays open for retries, and for a disabled
// owner too: they may still delete their own account. The operator routes have no
// Auth0 user; their own secret guards them.
app.use('/api/admin/*', async (c, next) => {
  if (READ_METHODS.has(c.req.method)) {
    const auth = await authenticate(c.req.raw, c.env);
    const limited = await rateLimit(c.env.READ_LIMITER, auth.sub, WRITE_RATE_PERIOD_SECONDS);
    if (limited) return limited;
    c.set('sub', auth.sub);
    c.set('auth', auth);
    return next();
  }
  if (!WRITE_METHODS.has(c.req.method)) return next();
  if (OPERATOR_PATHS.has(c.req.path)) return next();
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

// The caller's sub: from the gate when it ran, else verified here.
const ownerOf = async (c: Context<AppEnv>): Promise<string> =>
  c.get('sub') ?? (await authenticate(c.req.raw, c.env)).sub;

// The caller's whole verified token (sub, email, ...), the same way.
const authOf = async (c: Context<AppEnv>): Promise<AuthContext> =>
  c.get('auth') ?? (await authenticate(c.req.raw, c.env));

const refuse = (c: Context<AppEnv>, r: AccessRefusal) => c.json({ error: r.error }, r.status);

/**
 * Whose prefix a pano route uses: the caller's own, or with `?tourId=` naming a tour they
 * edit, the tour owner's. An editor reaches only a pano in that tour, or one that has no
 * config yet (their fresh upload, before Save adds it to the tour). Never for DELETE: an
 * editor removes a scene from the tour, and the pano stays in the owner's library.
 */
const panoOwnerOf = async (
  c: Context<AppEnv>,
  sub: string,
  panoId: string,
  write: boolean,
): Promise<string | AccessRefusal> => {
  const tourId = c.req.query('tourId');
  if (tourId === undefined) return sub;
  const access = await tourAccessFor(c.env.BUCKET, sub, tourId, { write });
  if (isRefusal(access)) return access;
  if (access.role === 'owner') return sub;
  // The tour's scenes are safe to go by: an editor can only add a pano they uploaded for it.
  const tour = await getJson<TourDoc>(c.env.BUCKET, tourKey(access.owner, tourId));
  if (tour?.value.scenes.some((s) => s.panoId === panoId)) return access.owner;
  return (await uploadedForTour(c.env.BUCKET, access.owner, tourId, panoId))
    ? access.owner
    : { status: 404, error: 'not found' };
};

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
  const caller = await ownerOf(c);
  const panoId = c.req.param('panoId');
  if (!isContentId(panoId)) {
    c.header('Cache-Control', NO_STORE);
    return c.json({ error: contentIdError('panoId') }, 400);
  }
  const sub = await panoOwnerOf(c, caller, panoId, false);
  if (typeof sub !== 'string') {
    c.header('Cache-Control', NO_STORE);
    return refuse(c, sub);
  }
  // Cheap polling path (the upload chip's failure detection, every 15s, and the
  // editor's tiling watch, every 10s; both every 30s once a pano is slow):
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
  const caller = await ownerOf(c);
  const panoId = c.req.param('panoId');
  const parsed = SceneConfigSchema.safeParse({
    ...(await jsonObjectBody(c.req.raw, MAX_CONFIG_BODY_BYTES)),
    panoId,
  });
  if (!parsed.success) return c.json({ error: parsed.error.format() }, 400);
  // 428 (no If-Match or If-None-Match) is checked before any state read, so it holds
  // regardless of whether a tombstone or the pano even exists. `If-None-Match: *` = create-only.
  const onlyIf = writeConditional(c.req.header('If-Match'), c.req.header('If-None-Match'));
  const sub = await panoOwnerOf(c, caller, panoId, true);
  if (typeof sub !== 'string') return refuse(c, sub);
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
  if (!isContentId(panoId)) {
    return c.json({ error: contentIdError('panoId') }, 400);
  }
  const limited = await rateLimit(c.env.PANO_DELETE_LIMITER, sub, PANO_DELETE_RATE_PERIOD_SECONDS);
  if (limited) return limited;
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
    ...(await jsonObjectBody(c.req.raw)),
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
  const caller = await ownerOf(c);
  const tourId = c.req.param('tourId');
  if (!isContentId(tourId)) {
    c.header('Cache-Control', NO_STORE);
    return c.json({ error: contentIdError('tourId') }, 400);
  }
  const access = await tourAccessFor(c.env.BUCKET, caller, tourId);
  if (isRefusal(access)) {
    c.header('Cache-Control', NO_STORE);
    return refuse(c, access);
  }
  const sub = access.owner;
  const role = access.role;
  // Heals the editor's dashboard index if its write was lost; tiny, so after the answer.
  if (role === 'editor') {
    c.executionCtx.waitUntil(recordMembership(c.env.BUCKET, caller, sub, tourId));
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
    return c.json({ tour, etag: obj.etag, publish, role });
  }
  const configs = await loadSceneConfigs(c.env.BUCKET, sub, tour.scenes);
  return c.json({ tour, etag: obj.etag, publish, role, configs });
});

app.put('/api/admin/tours/:tourId', async (c) => {
  const caller = await ownerOf(c);
  const tourId = c.req.param('tourId');
  const parsed = TourDocSchema.safeParse({
    ...(await jsonObjectBody(c.req.raw)),
    tourId,
  });
  if (!parsed.success) return c.json({ error: parsed.error.format() }, 400);
  // 428 before any state read, same reasoning as the config PUT above.
  const conditional = updateConditional(tourIfMatch(c.req.header('If-Match')));
  const access = await tourAccessFor(c.env.BUCKET, caller, tourId, { write: true });
  if (isRefusal(access)) return refuse(c, access);
  const sub = access.owner;
  let guard = conditional;
  if (access.role === 'editor') {
    // An editor adds only panos they uploaded for this tour, checked against the copy this
    // write then replaces (its ETag is the guard), so nothing slips in between.
    const saved = await getJson<TourDoc>(c.env.BUCKET, tourKey(sub, tourId));
    if (!saved) return c.json({ error: 'not found' }, 404);
    if (guard && guard.etagMatches !== saved.etag) return c.json({ error: 'conflict' }, 412);
    guard = { etagMatches: saved.etag };
    const refused = await scenesEditorMayNotAdd(
      c.env.BUCKET,
      sub,
      tourId,
      saved.value,
      parsed.data,
    );
    if (refused.length) return c.json({ error: 'pano not found', panoIds: refused }, 403);
  }
  // PUT never creates a tour - tourIds only ever come from POST - so a
  // missing key here is "not found", not a create (guardedPut's 404).
  const result = await guardedPut(
    c.env.BUCKET,
    tourKey(sub, tourId),
    parsed.data,
    guard,
    tourCustomMetadata(parsed.data),
  );
  if (!result.ok) {
    return c.json({ error: result.status === 404 ? 'not found' : 'conflict' }, result.status);
  }
  // A tour with a plan image needs its owner pointer: the daily plan sweep (plan-sweep.ts)
  // finds the tour.json through it, and leaves a tour without one alone. Create-only, so one
  // HEAD after the first save; tours created before pointers existed get theirs here.
  if (parsed.data.plan) {
    c.executionCtx.waitUntil(
      c.env.BUCKET.head(tourOwnerKey(tourId)).then((p) =>
        p ? undefined : recordTourOwner(c.env.BUCKET, sub, tourId),
      ),
    );
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
  if (!isContentId(tourId)) {
    return c.json({ error: contentIdError('tourId') }, 400);
  }
  // Counts like a pano delete: it sweeps every pano only this tour used.
  const limited = await rateLimit(c.env.PANO_DELETE_LIMITER, sub, PANO_DELETE_RATE_PERIOD_SECONDS);
  if (limited) return limited;
  const stub = publisher(c.env, tourId);
  purgeLater(c, await deleteTour(c.env.BUCKET, sub, tourId, () => stub.unpublish(sub, tourId)));
  return c.body(null, 204);
});

const tourIdError = (tourId: string): string | null =>
  isContentId(tourId) ? null : contentIdError('tourId');

const slugError = (slug: string): string | null => {
  const check = checkSlug(slug);
  return check.ok ? null : `${check.reason} slug`;
};

// All publish-state changes for a tour go through its TourPublisher, one at a time.
const publisher = (env: Env, tourId: string) => env.PUBLISHER.get(env.PUBLISHER.idFromName(tourId));

app.post('/api/admin/tours/:tourId/publish', async (c) => {
  const caller = await ownerOf(c);
  const tourId = c.req.param('tourId');
  const idError = tourIdError(tourId);
  if (idError) return c.json({ error: idError }, 400);
  const body = PublishRequestSchema.safeParse(await jsonBody(c.req.raw));
  if (!body.success) return c.json({ error: body.error.format() }, 400);
  const access = await tourAccessFor(c.env.BUCKET, caller, tourId, { write: true });
  if (isRefusal(access)) return refuse(c, access);
  // An editor's Save republishes what is already shared, as the owner's does; the share
  // link, its visibility and sharing a tour again stay the owner's.
  const { slug, visibility, afterSave } = body.data;
  if (access.role === 'editor' && (!afterSave || slug !== undefined || visibility !== undefined)) {
    return c.json({ error: 'owner only' }, 403);
  }
  const sub = access.owner;
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
  const body = SlugPutRequestSchema.safeParse(await jsonBody(c.req.raw));
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
  const body = VisibilityPatchRequestSchema.safeParse(await jsonBody(c.req.raw));
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

// --- Tour editors (members.ts) ---

app.get('/api/admin/tours/:tourId/members', async (c) => {
  const caller = await ownerOf(c);
  const tourId = c.req.param('tourId');
  c.header('Cache-Control', NO_STORE);
  const idError = tourIdError(tourId);
  if (idError) return c.json({ error: idError }, 400);
  const access = await tourAccessFor(c.env.BUCKET, caller, tourId);
  if (isRefusal(access)) return refuse(c, access);
  return c.json(await getMembers(c.env.BUCKET, access, caller, tourId));
});

app.post('/api/admin/tours/:tourId/invites', async (c) => {
  const auth = await authOf(c);
  const tourId = c.req.param('tourId');
  const idError = tourIdError(tourId);
  if (idError) return c.json({ error: idError }, 400);
  const body = InviteCreateRequestSchema.safeParse(await jsonBody(c.req.raw));
  if (!body.success) return c.json({ error: 'email must be an email address' }, 400);
  const access = await tourAccessFor(c.env.BUCKET, auth.sub, tourId, { ownerOnly: true });
  if (isRefusal(access)) return refuse(c, access);
  const out = await createInvite(
    c.env.BUCKET,
    { sub: auth.sub, email: auth.email },
    tourId,
    body.data.email,
    new Date(),
  );
  return c.json(out.body, out.status);
});

app.delete('/api/admin/tours/:tourId/invites/:inviteId', async (c) => {
  const caller = await ownerOf(c);
  const tourId = c.req.param('tourId');
  const idError = tourIdError(tourId);
  if (idError) return c.json({ error: idError }, 400);
  const access = await tourAccessFor(c.env.BUCKET, caller, tourId, { ownerOnly: true });
  if (isRefusal(access)) return refuse(c, access);
  await revokeInvite(c.env.BUCKET, caller, tourId, c.req.param('inviteId'));
  return c.body(null, 204);
});

// The owner removes an editor, or an editor leaves (their own member id).
app.delete('/api/admin/tours/:tourId/members/:memberId', async (c) => {
  const caller = await ownerOf(c);
  const tourId = c.req.param('tourId');
  const idError = tourIdError(tourId);
  if (idError) return c.json({ error: idError }, 400);
  const access = await tourAccessFor(c.env.BUCKET, caller, tourId);
  if (isRefusal(access)) return refuse(c, access);
  const ok = await removeMember(c.env.BUCKET, access, caller, tourId, c.req.param('memberId'));
  return ok ? c.body(null, 204) : c.json({ error: 'owner only' }, 403);
});

app.post('/api/admin/invites/accept', async (c) => {
  const auth = await authOf(c);
  const body = InviteAcceptRequestSchema.safeParse(await jsonBody(c.req.raw));
  if (!body.success) return c.json({ error: 'invite not found' }, 404);
  const out = await acceptInvite(
    c.env.BUCKET,
    { sub: auth.sub, email: auth.email },
    body.data.token,
    new Date(),
  );
  return c.json(out.body, out.status);
});

app.get('/api/admin/shared-tours', async (c) => {
  const caller = await ownerOf(c);
  c.header('Cache-Control', NO_STORE);
  const tours = await listSharedTours(c.env.BUCKET, caller, (p) => c.executionCtx.waitUntil(p));
  return c.json({ tours });
});

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

// The account page's sign-in details, straight from the verified token: nothing stored.
app.get(ACCOUNT_PATH, async (c) => {
  const auth = await authOf(c);
  const signIns = [auth.sub, ...(auth.linkedSubs ?? [])].map(signInOf).filter(Boolean);
  c.header('Cache-Control', NO_STORE);
  return c.json({
    email: auth.email ?? null,
    signIns: [...new Set(signIns)],
  } satisfies AccountView);
});

app.delete(ACCOUNT_PATH, async (c) => {
  const auth = c.get('auth') ?? (await authenticate(c.req.raw, c.env));
  const body = AccountDeleteRequestSchema.safeParse(await jsonBody(c.req.raw));
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
  const body = OperatorTakedownRequestSchema.safeParse(await jsonBody(c.req.raw));
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
  // Tiles are purged by URL, not by prefix, so a takedown never waits on the prefix budget
  // anyone's pano deletes can use up; and before answering, so the operator sees the outcome.
  // Metered, so the purge only spends the subrequests the delete left (a big tour's
  // delete is many R2 calls); what doesn't fit is queued, never lost.
  const meter = meteredBucket(c.env.BUCKET);
  // A takedown's delete is for real: no trash copy (quarantine keeps what must be kept),
  // and the trash copies of the tour's originals an owner deleted before it go too.
  const scenes =
    action === 'delete'
      ? ((await getJson<TourDoc>(meter.bucket, tourKey(sub, tourId)))?.value.scenes ?? [])
      : [];
  const purge =
    action === 'delete'
      ? await deleteTour(
          meter.bucket,
          sub,
          tourId,
          () => stub.unpublish(sub, tourId, false, true),
          {
            trash: false,
            tilesByUrl: true,
          },
        )
      : { prefixes: [], files: await stub.unpublish(sub, tourId, true, true) };
  const planned = purge.prefixes.length + purge.files.length;
  const room =
    SUBREQUEST_LIMIT -
    meter.calls() -
    OPERATOR_ROUTE_RESERVE -
    Math.ceil(planned / PENDING_RECORD_MAX_ITEMS);
  // purgeCdn doesn't throw; the catch only makes sure a takedown whose R2 data is
  // already gone never answers 500.
  const outcome = await purgeCdn(c.env, purge, {
    maxRequests: Math.max(0, Math.min(OPERATOR_PURGE_MAX_REQUESTS, room)),
    deadline: Date.now() + OPERATOR_PURGE_DEADLINE_MS,
    priority: true,
  }).catch((): CdnPurgeOutcome => ({ status: 'failed', purged: 0, pending: 0, failed: planned }));
  // After the purge, and never failing the takedown: the tour's data is already gone, so a
  // 500 here would leave a retry nothing to find. A copy left behind ages out of the trash.
  if (scenes.length) {
    const originals = new Set(scenes.map((s) => originalKey(sub, s.panoId)));
    try {
      await deleteFromTrash(meter.bucket, userPanosPrefix(sub), (k) => originals.has(k));
    } catch (e) {
      console.error(
        `[takedown] trash copies for tour ${tourId} not deleted:`,
        e instanceof Error ? e.name : 'unknown error',
      );
    }
  }
  // An audit line for the logs: what was done to which tour. Never the sub (reversible to the owner).
  console.warn(`[takedown] operator ${action} of tour ${tourId} done; cdn purge ${outcome.status}`);
  return c.json({ action, purged: planned, purge: outcome });
});

// Operator restore (scripts/restore-backup.ts): copies keys back from a day's backup set,
// or originals from a day's trash, through the binding so each object's metadata comes
// back exactly. Same token as takedown.
app.post(OPERATOR_RESTORE_PATH, async (c) => {
  if (!(await isOperator(c.env.OPERATOR_TOKEN, c.req.header(OPERATOR_TOKEN_HEADER)))) {
    return c.json({ error: 'not found' }, 404);
  }
  const body = OperatorRestoreRequestSchema.safeParse(await jsonBody(c.req.raw));
  if (!body.success) return c.json({ error: body.error.format() }, 400);
  const { from, date, keys, overwrite } = body.data;
  const out =
    from === 'trash'
      ? await restoreFromTrash(c.env.BUCKET, date, keys, overwrite)
      : await restoreFromBackup(c.env.BUCKET, date, keys, overwrite);
  // A share link or bundle that 404ed may be cached as such; the restored ones are purged.
  const files = out.restored.filter((k) => k.startsWith('pub/') || k.startsWith('slugs/'));
  purgeLater(c, { prefixes: [], files });
  // An audit line: counts only, keys carry the owner.
  console.warn(
    `[restore] operator restore from ${from} ${date}: ${out.restored.length} restored, ${out.existing.length} left as they are, ${out.missing.length} not in the set, ${out.refused.length} refused, ${out.failed.length} failed`,
  );
  return c.json(out);
});

// Operator backfill (scripts/backfill-covers.ts): covers, owner pointers and Explore entries
// for tours written before them, a page at a time; reports only unless `apply`.
app.post(OPERATOR_BACKFILL_PATH, async (c) => {
  if (!(await isOperator(c.env.OPERATOR_TOKEN, c.req.header(OPERATOR_TOKEN_HEADER)))) {
    return c.json({ error: 'not found' }, 404);
  }
  const body = OperatorBackfillRequestSchema.safeParse(await jsonBody(c.req.raw));
  if (!body.success) return c.json({ error: body.error.format() }, 400);
  const out = await backfillTours(c.env.BUCKET, body.data, (tourId) =>
    publisher(c.env, tourId).refreshExplore(tourId),
  );
  const changed = out.tours.filter((t) => t.changes.length).length;
  console.warn(
    `[backfill] ${body.data.apply ? 'updated' : 'would update'} ${changed} of ${out.tours.length} tour(s)`,
  );
  return c.json(out);
});

app.onError(errorHandler);

export default {
  fetch: app.fetch,
  // Daily Cron Trigger: releases slug aliases past their expiresAt (Q6),
  // finishes (or re-sweeps) every account marked for deletion, checks the tile
  // sweep has been finishing cleanly, empties trash/ of originals deleted 30 days
  // ago (trash.ts), and deletes plan images no tour will ever save
  // (plan-sweep.ts), purged from the CDN.
  // The backup has its own, more frequent cron (backup.ts), so it gets its own
  // invocation's subrequest budget and can resume a set the last run didn't finish.
  // The same invocation first retries queued CDN purges (purge.ts, at most
  // RETRY_RUN_MAX_SUBREQUESTS), and after the backup deletes tile versions a re-tile
  // superseded more than a day ago, with what the backup left (tile-gc.ts; no purge:
  // nothing references their URLs any more, and edge copies age out on their own).
  // It returns before runDailyCron, so the 15-minute cron never runs the daily
  // tasks or records a daily cron run.
  // runDailyCron logs each task that throws and records the run for the health check.
  scheduled(controller, env, ctx) {
    const now = new Date(controller.scheduledTime);
    if (controller.cron === BACKUP_CRON) {
      ctx.waitUntil(
        retryPendingPurges(env, now)
          .catch((e: unknown) => {
            console.error('cdn purge retry failed:', e instanceof Error ? e.name : 'unknown error');
          })
          .then(() => runBackupThenTileGc(env.BUCKET, now, { totalOps: FIFTEEN_MINUTE_RUN_OPS })),
      );
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
        trash: () => sweepTrash(env.BUCKET, now),
        'plan-sweep': () =>
          sweepUnsavedPlans(env.BUCKET, now).then((r) =>
            purgeCdn(env, { prefixes: [], files: r.deleted }),
          ),
      }),
    );
  },
} satisfies ExportedHandler<Env>;

export { TourPublisher };
