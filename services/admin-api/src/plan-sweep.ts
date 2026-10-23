import {
  planKey,
  PLANS_ROOT,
  pubTourKey,
  tourIdOfPlanKey,
  tourKey,
  tourOwnerKey,
  TourOwnerRecordSchema,
  TourPlanSchema,
} from '@internal/contracts';

// The daily sweep of floor-plan images nothing will ever save (plans.ts holds the per-tour
// sweep that runs after each save). An upload the editor never saved stays under
// pub/plans/<tourId>/ until that tour's next save or its delete, which may never come: an
// abandoned editor, or a tour deleted by a path that raced the upload. This lists all of
// pub/plans/, a slice a day, and for each tour:
// - with no readable tour-owners pointer, leaves every image alone: without it the sweep
//   can't find the tour.json, and a saved but unpublished tour (one from before pointers, or
//   whose save lost its best-effort pointer write) would look gone. It counts these as
//   `unknown`; the operator's backfill (scripts/backfill-covers.ts) writes the missing
//   pointers, and a save with a plan writes its own;
// - if the pointer names an owner whose tour.json is gone and there is no live bundle, the
//   tour is gone (deletes take tour.json before the pointer, so this is a delete that
//   stopped half-way, or one that raced the upload): deletes its images older than
//   PLAN_ORPHAN_GRACE_MS;
// - otherwise deletes images older than PLAN_UNUSED_GRACE_MS that neither the stored
//   tour.json nor the live bundle names. That is the editor's draft autosave window
//   (DRAFT_MAX_AGE_MS in apps/admin's draft.ts), so a plan a local draft still holds survives
//   as long as the draft could be restored.
// A run that spends its budget saves where it got to in PLAN_SWEEP_CURSOR_KEY (private, under
// ops/), and the next day's run carries on from there; a pass that reaches the end starts
// over the day after.

const DAY_MS = 24 * 60 * 60 * 1000;
export const PLAN_ORPHAN_GRACE_MS = DAY_MS;
export const PLAN_UNUSED_GRACE_MS = 7 * DAY_MS;
// R2 operations one run makes at most: a listing page (1,000 keys), and per tour with an
// image old enough to judge up to four (its owner pointer, tour.json, bundle, one batch
// delete). Far under the cron invocation's subrequest limit, shared with the other tasks.
export const PLAN_SWEEP_BUDGET = 400;
export const PLAN_SWEEP_CURSOR_KEY = 'ops/plan-sweep/cursor.json';

const LOG_PREFIX = '[plan-sweep]';
// The most one tour's judgement costs: owner pointer, tour.json, bundle, delete.
const TOUR_COST = 4;

export type PlanSweepResult = {
  /** Keys deleted, to purge from the CDN. */
  deleted: string[];
  /** Tours whose images were judged (read and maybe deleted). */
  tours: number;
  /** Tours left alone because they have no readable owner pointer to judge them by. */
  unknown: number;
  /** True when this run reached the end of pub/plans/; false when the budget ran out. */
  done: boolean;
};

// Present but not JSON: not "gone", and naming nothing the sweep can read.
const UNREADABLE = Symbol('unreadable');

const readJson = async (bucket: R2Bucket, key: string): Promise<unknown> => {
  const obj = await bucket.get(key);
  if (!obj) return null;
  try {
    return JSON.parse(await obj.text());
  } catch {
    return UNREADABLE;
  }
};

/**
 * The image key a stored tour or bundle names: null when it names none (no doc, or no
 * plan), UNREADABLE when it can't be told (a doc that isn't JSON, or a plan that doesn't
 * parse), in which case the image it may name must not be judged unused.
 */
const storedKey = (tourId: string, doc: unknown): string | null | typeof UNREADABLE => {
  if (doc === UNREADABLE) return UNREADABLE;
  if (doc === null || typeof doc !== 'object') return doc === null ? null : UNREADABLE;
  const plan = (doc as { plan?: unknown }).plan;
  if (plan === undefined) return null;
  const parsed = TourPlanSchema.safeParse(plan);
  return parsed.success ? planKey(tourId, parsed.data.id, parsed.data.type) : UNREADABLE;
};

const readCursor = async (bucket: R2Bucket): Promise<string | undefined> => {
  const body = await readJson(bucket, PLAN_SWEEP_CURSOR_KEY);
  const startAfter =
    body !== null && typeof body === 'object'
      ? (body as { startAfter?: unknown }).startAfter
      : null;
  return typeof startAfter === 'string' && startAfter.startsWith(PLANS_ROOT)
    ? startAfter
    : undefined;
};

/**
 * One tour's images: which to delete. `objects` are all the tour's images in this listing
 * page. Reads the tour only when an image is old enough for either rule.
 */
const judgeTour = async (
  bucket: R2Bucket,
  tourId: string,
  objects: readonly R2Object[],
  now: number,
): Promise<{ stale: string[]; operations: number; unknown: boolean }> => {
  const age = (o: R2Object) => now - o.uploaded.getTime();
  if (!objects.some((o) => age(o) > PLAN_ORPHAN_GRACE_MS)) {
    return { stale: [], operations: 0, unknown: false };
  }
  const pointer = TourOwnerRecordSchema.safeParse(await readJson(bucket, tourOwnerKey(tourId)));
  // No evidence either way: the tour may be saved and unpublished. Keep everything.
  if (!pointer.success) return { stale: [], operations: 1, unknown: true };
  const [tour, bundle] = await Promise.all([
    readJson(bucket, tourKey(pointer.data.sub, tourId)),
    readJson(bucket, pubTourKey(tourId)),
  ]);
  const operations = 3;
  if (tour === null && bundle === null) {
    return {
      stale: objects.filter((o) => age(o) > PLAN_ORPHAN_GRACE_MS).map((o) => o.key),
      operations,
      unknown: false,
    };
  }
  const keep = new Set([storedKey(tourId, tour), storedKey(tourId, bundle)]);
  // A tour.json or bundle that can't be read might name any of the images: keep them all.
  if (keep.has(UNREADABLE)) return { stale: [], operations, unknown: false };
  return {
    stale: objects
      .filter((o) => age(o) > PLAN_UNUSED_GRACE_MS && !keep.has(o.key))
      .map((o) => o.key),
    operations,
    unknown: false,
  };
};

/**
 * Daily cron task: carries on through pub/plans/ from the saved cursor, judging each tour's
 * images, until the end or `budget` R2 operations. Returns the keys it deleted, for the CDN
 * purge. One tour failing is logged and skipped; the next pass sees it again.
 */
export const sweepUnsavedPlans = async (
  bucket: R2Bucket,
  now: Date,
  budget = PLAN_SWEEP_BUDGET,
): Promise<PlanSweepResult> => {
  const result: PlanSweepResult = { deleted: [], tours: 0, unknown: 0, done: false };
  let operations = 1;
  const resumeFrom = await readCursor(bucket);
  // The last key every image up to which has been judged.
  let done = resumeFrom;

  const stop = async (): Promise<PlanSweepResult> => {
    if (done !== resumeFrom && done !== undefined) {
      await bucket.put(PLAN_SWEEP_CURSOR_KEY, JSON.stringify({ v: 1, startAfter: done }), {
        httpMetadata: { contentType: 'application/json' },
      });
    }
    console.warn(
      `${LOG_PREFIX} deleted ${result.deleted.length} unsaved plan image(s) of ${result.tours} tour(s), ${result.unknown} with no owner pointer left alone; budget reached, the next run carries on`,
    );
    return result;
  };

  // One reserved for the cursor write that ends a partial run.
  const room = (n: number) => operations + n + 1 <= budget;
  let startAfter = resumeFrom;
  for (;;) {
    if (!room(1)) return stop();
    operations += 1;
    const page = await bucket.list({
      prefix: PLANS_ROOT,
      ...(startAfter !== undefined ? { startAfter } : {}),
    });
    // Consecutive keys of one tour (R2 lists in key order, so a tour's images are together).
    const groups: { tourId: string | null; objects: R2Object[] }[] = [];
    for (const o of page.objects) {
      const tourId = tourIdOfPlanKey(o.key);
      const last = groups.at(-1);
      if (last && last.tourId === tourId) last.objects.push(o);
      else groups.push({ tourId, objects: [o] });
    }
    for (const group of groups) {
      if (group.tourId !== null) {
        if (!room(TOUR_COST)) return stop();
        try {
          const {
            stale,
            operations: reads,
            unknown,
          } = await judgeTour(bucket, group.tourId, group.objects, now.getTime());
          operations += reads;
          if (unknown) result.unknown += 1;
          else if (reads) result.tours += 1;
          if (stale.length) {
            operations += 1;
            await bucket.delete(stale);
            result.deleted.push(...stale);
          }
        } catch (e) {
          // The name only: R2 error messages can carry keys.
          console.error(
            `${LOG_PREFIX} one tour skipped:`,
            e instanceof Error ? e.name : 'unknown error',
          );
        }
      }
      // Anything that isn't a plan image's key is left alone.
      done = group.objects.at(-1)!.key;
    }
    if (!page.truncated) break;
    startAfter = page.objects.at(-1)?.key ?? startAfter;
  }
  // The whole prefix is done: the next run starts from the top.
  if (resumeFrom !== undefined) await bucket.delete(PLAN_SWEEP_CURSOR_KEY);
  result.done = true;
  if (result.deleted.length) {
    console.warn(
      `${LOG_PREFIX} deleted ${result.deleted.length} unsaved plan image(s) of ${result.tours} tour(s)`,
    );
  }
  if (result.unknown) {
    console.warn(
      `${LOG_PREFIX} left ${result.unknown} tour(s) alone with no owner pointer; run backfill-covers --apply`,
    );
  }
  return result;
};
