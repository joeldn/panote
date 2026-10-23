import {
  accountDeletionKey,
  AccountDeletionRecordSchema,
  accountDisabledKey,
  AccountDisabledRecordSchema,
  accountSinceKey,
  exploreHiddenKey,
  isContentId,
  isOriginalKey,
  MAX_TOURS_PER_OWNER,
  originalKey,
  REAUTH_REQUIRED_ERROR,
  SlugRecordSchema,
  storedSlugKey,
  SUPPORT_QUERY_MAX,
  SupportCloseRequestSchema,
  SupportDisableRequestSchema,
  SupportRestoreRequestSchema,
  SupportTourActionRequestSchema,
  tourOwnerKey,
  TourOwnerRecordSchema,
  TRASH_RETENTION_DAYS,
  trashDayPrefix,
  userMembershipsPrefix,
  userPanosPrefix,
  userUploadLogPrefix,
  uploadLogTime,
  type AccountDisabledRecord,
  type SupportLookupOk,
  type SupportTour,
  type SupportTrashItem,
  type SupportUserView,
} from '@internal/contracts';
import type { AuthContext } from '@internal/worker-kit';
import { getJson, putJson } from '@internal/worker-kit/r2-binding';
import { Hono, type Context } from 'hono';

import { markAccountForDeletion } from './delete-account.js';
import { jsonBody } from './limits.js';
import { listTourSummaries } from './lists.js';
import { isTransferring, readMembers } from './members.js';
import { tourExists } from './operator.js';
import { subHash } from './ops-gate.js';
import { purgeCdn } from './purge.js';
import { isRecentAuth, requiresRecentAuth } from './recent-auth.js';
import { holdings, ownerLimits } from './transfer.js';
import { restoreFromTrash } from './trash.js';

// The operator's support routes, mounted at SUPPORT_USERS_PATH behind the operator gate:
// look an account up, see it on one page, and the few changes the operator scripts make
// (scripts/takedown.ts, delete-account.ts, restore-backup.ts), from the admin app. Writes
// need a recent sign-in as well, so a session left open somewhere can't change accounts.
// Every write logs an audit line with the action and the tour or pano, never the sub.

export type SupportEnv = {
  Bindings: Env;
  Variables: { sub: string | undefined; auth?: AuthContext };
};
type C = Context<SupportEnv>;

const NO_STORE = 'private, no-store';
const PER_TOUR_CONCURRENCY = 8;
const ID_MAX = SUPPORT_QUERY_MAX;

const publisher = (env: Env, tourId: string) => env.PUBLISHER.get(env.PUBLISHER.idFromName(tourId));

/** The sub a path names: present, not padded, and short; else null. */
const subParam = (c: C): string | null => {
  const sub = c.req.param('sub');
  if (!sub || sub.length > ID_MAX || sub.trim() !== sub) return null;
  return sub;
};

/** The owner the tour-owner pointer names, once that owner is seen to still hold the tour. */
const ownerOfTour = async (bucket: R2Bucket, tourId: string): Promise<string | null> => {
  if (!isContentId(tourId)) return null;
  const got = await getJson<unknown>(bucket, tourOwnerKey(tourId)).catch(() => null);
  const parsed = got ? TourOwnerRecordSchema.safeParse(got.value) : null;
  if (!parsed?.success) return null;
  return (await tourExists(bucket, parsed.data.sub, tourId)) ? parsed.data.sub : null;
};

/** The slug in a share link (…/s/<slug>, any host, query or fragment ignored) or a bare slug. */
const slugOf = (q: string): string | null => {
  const path = /^https?:\/\//i.test(q) ? safePath(q) : q;
  if (path === null) return null;
  const m = /(?:^|\/)s\/([^/?#]+)/.exec(path);
  return (m ? decodeSafe(m[1]!) : path).toLowerCase();
};
const safePath = (url: string): string | null => {
  try {
    return new URL(url).pathname;
  } catch {
    return null;
  }
};
const decodeSafe = (s: string): string => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/**
 * What `q` names: an account ID (it has a `|`, as every Auth0 user id does), a tourId,
 * or a share link or slug. A tour is found only through its owner pointer, written on
 * every create and publish; an older tour that has neither needs scripts/takedown.ts.
 */
export const lookup = async (bucket: R2Bucket, q: string): Promise<SupportLookupOk | null> => {
  if (q.includes('|')) return { sub: q, via: 'sub', tourId: null };
  if (isContentId(q)) {
    const sub = await ownerOfTour(bucket, q);
    if (sub) return { sub, via: 'tour', tourId: q };
  }
  const slug = slugOf(q);
  const key = slug === null ? null : storedSlugKey(slug);
  if (key === null) return null;
  const got = await getJson<unknown>(bucket, key).catch(() => null);
  const record = got ? SlugRecordSchema.safeParse(got.value) : null;
  if (!record?.success) return null;
  const sub = await ownerOfTour(bucket, record.data.tourId);
  return sub ? { sub, via: 'slug', tourId: record.data.tourId } : null;
};

const readParsed = async <T>(
  bucket: R2Bucket,
  key: string,
  schema: { safeParse: (v: unknown) => { success: true; data: T } | { success: false } },
): Promise<T | null> => {
  const got = await getJson<unknown>(bucket, key).catch(() => null);
  const parsed = got ? schema.safeParse(got.value) : null;
  return parsed?.success ? parsed.data : null;
};

/** Every key under `prefix`, all pages. */
const listAll = async (bucket: R2Bucket, prefix: string): Promise<R2Object[]> => {
  const out: R2Object[] = [];
  let cursor: string | undefined;
  do {
    const listed = await bucket.list({ prefix, ...(cursor ? { cursor } : {}) });
    out.push(...listed.objects);
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  return out;
};

const UPLOAD_WINDOW_MS = 24 * 60 * 60 * 1000;

const uploadsToday = async (bucket: R2Bucket, sub: string, nowMs: number): Promise<number> => {
  const prefix = userUploadLogPrefix(sub);
  return (await listAll(bucket, prefix)).filter(
    (o) => uploadLogTime(o.key.slice(prefix.length)) >= nowMs - UPLOAD_WINDOW_MS,
  ).length;
};

/** The trash days still kept, newest first, as YYYY-MM-DD. */
const trashDays = (now: Date): string[] =>
  Array.from({ length: TRASH_RETENTION_DAYS + 1 }, (_, i) =>
    new Date(now.getTime() - i * UPLOAD_WINDOW_MS).toISOString().slice(0, 10),
  );

const trashOf = async (bucket: R2Bucket, sub: string, now: Date): Promise<SupportTrashItem[]> => {
  const own = userPanosPrefix(sub);
  const days = await Promise.all(
    trashDays(now).map(async (date) => {
      const prefix = `${trashDayPrefix(date)}${own}`;
      return (await listAll(bucket, prefix)).flatMap((o): SupportTrashItem[] => {
        const key = o.key.slice(trashDayPrefix(date).length);
        if (!isOriginalKey(key)) return [];
        const panoId = key.slice(own.length, -'/original'.length);
        return [{ date, key, panoId, bytes: o.size }];
      });
    }),
  );
  return days.flat();
};

const toursOf = async (bucket: R2Bucket, sub: string): Promise<SupportTour[]> => {
  const summaries = [];
  let cursor: string | undefined;
  do {
    const page = await listTourSummaries(bucket, sub, cursor, 100);
    summaries.push(...page.tours);
    cursor = page.cursor ?? undefined;
  } while (cursor && summaries.length < MAX_TOURS_PER_OWNER);
  const out: SupportTour[] = [];
  for (let i = 0; i < summaries.length; i += PER_TOUR_CONCURRENCY) {
    out.push(
      ...(await Promise.all(
        summaries.slice(i, i + PER_TOUR_CONCURRENCY).map(async (t) => {
          // Per tour, so the cost follows the account (at most 3 calls a tour, 200 tours),
          // never the size of a global prefix. Only a published tour can be on Explore.
          const [hidden, members, transferring] = await Promise.all([
            t.publish ? bucket.head(exploreHiddenKey(t.tourId)) : null,
            readMembers(bucket, sub, t.tourId),
            isTransferring(bucket, t.tourId),
          ]);
          return {
            tourId: t.tourId,
            title: t.title,
            sceneCount: t.sceneCount,
            updatedAt: t.updatedAt,
            publish: t.publish,
            hiddenFromExplore: !!hidden,
            editors: members.members.members.length,
            transferring,
          };
        }),
      )),
    );
  }
  return out;
};

/** One account, everything support needs. Reads only: nothing is created or latched. */
export const userView = async (env: Env, sub: string, now: Date): Promise<SupportUserView> => {
  const bucket = env.BUCKET;
  const [disabled, deletion, since, held, uploads, tours, memberships, trash] = await Promise.all([
    readParsed(bucket, accountDisabledKey(sub), AccountDisabledRecordSchema),
    readParsed(bucket, accountDeletionKey(sub), AccountDeletionRecordSchema),
    getJson<{ since?: unknown }>(bucket, accountSinceKey(sub)).catch(() => null),
    holdings(bucket, sub),
    uploadsToday(bucket, sub, now.getTime()),
    toursOf(bucket, sub),
    listAll(bucket, userMembershipsPrefix(sub)),
    trashOf(bucket, sub, now),
  ]);
  const limits = ownerLimits(env);
  const membershipPrefix = userMembershipsPrefix(sub);
  return {
    sub,
    since: typeof since?.value.since === 'string' ? since.value.since : null,
    disabled: disabled && {
      disabledAt: disabled.disabledAt,
      ...(disabled.reason !== undefined && { reason: disabled.reason }),
    },
    deletion: deletion && {
      requestedAt: deletion.requestedAt,
      ...(deletion.completedAt !== undefined && { completedAt: deletion.completedAt }),
    },
    usage: { panos: held.panos, bytes: held.bytes, uploadsToday: uploads, tours: tours.length },
    limits: { maxPanos: limits.maxPanos, maxBytes: limits.maxBytes, maxTours: MAX_TOURS_PER_OWNER },
    tours,
    editsTours: memberships
      .map((o) => o.key.slice(membershipPrefix.length, -'.json'.length))
      .filter((id) => id.length > 0),
    trash,
  };
};

/** The operator's sign-in must be recent for a write (REQUIRE_RECENT_AUTH, as account delete). */
export const staleSignIn = (c: C): boolean =>
  requiresRecentAuth(c.env) && !isRecentAuth(c.get('auth')?.authTime, Date.now());

/**
 * Who acted, for the audit lines: the first 12 hex of the operator's own sub hash (as
 * OPERATOR_SUB_SHA256 lists it), so a line is attributable without naming anyone.
 */
export const by = async (c: C): Promise<string> =>
  `by ${(await subHash(c.get('sub') ?? '')).slice(0, 12)}`;

/** Answers a write with the account as it is now. */
const viewNow = async (c: C, sub: string) => {
  c.header('Cache-Control', NO_STORE);
  return c.json(await userView(c.env, sub, new Date()));
};

export const supportRoutes = new Hono<SupportEnv>();

supportRoutes.use('*', async (c, next) => {
  if (c.req.method !== 'GET' && staleSignIn(c)) {
    return c.json({ error: REAUTH_REQUIRED_ERROR }, 403);
  }
  await next();
});

supportRoutes.get('/lookup', async (c) => {
  const q = (c.req.query('q') ?? '').trim();
  if (!q || q.length > SUPPORT_QUERY_MAX) return c.json({ error: 'q is required' }, 400);
  c.header('Cache-Control', NO_STORE);
  const found = await lookup(c.env.BUCKET, q);
  return found ? c.json(found) : c.json({ error: 'not found' }, 404);
});

supportRoutes.get('/:sub', async (c) => {
  const sub = subParam(c);
  if (!sub) return c.json({ error: 'invalid account ID' }, 400);
  return viewNow(c, sub);
});

// Disable: the same marker scripts/takedown.ts --disable-owner writes. Every owner write
// and upload URL answers 403 while it exists; reads still work. Allowed for an ID that
// holds nothing yet, on purpose, like the script: it blocks a known Auth0 user (one named
// in a report) before they upload. Auth0 ids are random, so a mistyped one won't later
// belong to someone; Enable removes it either way.
supportRoutes.post('/:sub/disable', async (c) => {
  const sub = subParam(c);
  if (!sub) return c.json({ error: 'invalid account ID' }, 400);
  const body = SupportDisableRequestSchema.safeParse(await jsonBody(c.req.raw));
  if (!body.success) return c.json({ error: 'a reason is required' }, 400);
  const record: AccountDisabledRecord = {
    v: 1,
    disabledAt: new Date().toISOString(),
    reason: body.data.reason,
  };
  await putJson(c.env.BUCKET, accountDisabledKey(sub), record);
  console.warn(`[support] operator disabled an account ${await by(c)}`);
  return viewNow(c, sub);
});

supportRoutes.post('/:sub/enable', async (c) => {
  const sub = subParam(c);
  if (!sub) return c.json({ error: 'invalid account ID' }, 400);
  await c.env.BUCKET.delete(accountDisabledKey(sub));
  console.warn(`[support] operator enabled an account ${await by(c)}`);
  return viewNow(c, sub);
});

// The takedown route's unpublish, hide and unhide, for a tour this account owns. No
// delete here: one that keeps nothing is the script's, with its quarantine and checks.
supportRoutes.post('/:sub/tours/:tourId', async (c) => {
  const sub = subParam(c);
  const tourId = c.req.param('tourId');
  if (!sub) return c.json({ error: 'invalid account ID' }, 400);
  // Checked before it names an R2 key or a Durable Object.
  if (!isContentId(tourId)) return c.json({ error: 'tour not found' }, 404);
  const body = SupportTourActionRequestSchema.safeParse(await jsonBody(c.req.raw));
  if (!body.success) return c.json({ error: body.error.format() }, 400);
  if (!(await tourExists(c.env.BUCKET, sub, tourId))) {
    return c.json({ error: 'tour not found' }, 404);
  }
  const { action } = body.data;
  const stub = publisher(c.env, tourId);
  if (action === 'unpublish') {
    const files = await stub.unpublish(sub, tourId, true, true);
    c.executionCtx.waitUntil(purgeCdn(c.env, { prefixes: [], files }, { priority: true }));
  } else if (!(await stub.setExploreHidden(sub, tourId, action === 'hide'))) {
    return c.json({ error: 'tour not found' }, 404);
  }
  console.warn(`[support] operator ${action} of tour ${tourId} done ${await by(c)}`);
  return viewNow(c, sub);
});

// One deleted original back from the trash, create-only. The R2 notification re-tiles it.
supportRoutes.post('/:sub/restore', async (c) => {
  const sub = subParam(c);
  if (!sub) return c.json({ error: 'invalid account ID' }, 400);
  const body = SupportRestoreRequestSchema.safeParse(await jsonBody(c.req.raw));
  if (!body.success || !isContentId(body.data.panoId)) {
    return c.json({ error: 'date and panoId are required' }, 400);
  }
  const out = await restoreFromTrash(
    c.env.BUCKET,
    body.data.date,
    [originalKey(sub, body.data.panoId)],
    false,
  );
  if (out.missing.length) return c.json({ error: 'not in the trash' }, 404);
  if (out.existing.length) return c.json({ error: 'already restored' }, 409);
  if (out.refused.length) return c.json({ error: 'account deleted' }, 410);
  if (out.failed.length) return c.json({ error: 'restore failed' }, 500);
  console.warn(
    `[support] operator restored pano ${body.data.panoId} from the trash ${await by(c)}`,
  );
  return viewNow(c, sub);
});

// Close: the deletion marker the owner's own Delete account writes; the daily sweep does
// the rest. `confirm` must repeat the account ID, so a wrong page can't close an account.
supportRoutes.post('/:sub/close', async (c) => {
  const sub = subParam(c);
  if (!sub) return c.json({ error: 'invalid account ID' }, 400);
  const body = SupportCloseRequestSchema.safeParse(await jsonBody(c.req.raw));
  if (!body.success || body.data.confirm !== sub) {
    return c.json({ error: 'confirm must repeat the account ID' }, 400);
  }
  await markAccountForDeletion(c.env.BUCKET, sub, new Date());
  console.warn(`[support] operator marked an account for deletion ${await by(c)}`);
  return viewNow(c, sub);
});
