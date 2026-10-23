import { z } from 'zod';

import { EXPLORE_CURSOR_PATTERN, EXPLORE_INDEX_ROOT, PANO_PATTERN } from './keys.js';
import { MAX_ID_LENGTH } from './schema.js';

// Explore: the list of Public tours (decisions.md, "Explore index"). Everything
// here is public, so nothing may carry an owner id, name or email.

const publicId = () => z.string().regex(PANO_PATTERN).max(MAX_ID_LENGTH);

/** public-api's route: GET EXPLORE_PATH[?cursor=<cursor>]. */
export const EXPLORE_PATH = '/api/explore';
/** Tours per page. */
export const EXPLORE_PAGE_SIZE = 24;

// The start scene's own image, as the tiler wrote it next to its tiles: og.jpg
// (a 1200×630 normal-camera view) when there is one, else the 2:1 equirect preview.
export const ExploreCoverSchema = z.object({
  panoId: publicId(),
  version: publicId(),
  image: z.enum(['og', 'preview']),
});
export type ExploreCover = z.infer<typeof ExploreCoverSchema>;

// explore/index/<rank>-<tourId>.json, written by admin-api's publish.
export const ExploreEntrySchema = z.object({
  v: z.literal(1),
  tourId: publicId(),
  slug: z.string(),
  title: z.string(),
  sceneCount: z.number().int().nonnegative(),
  cover: ExploreCoverSchema.nullable(),
  publishedAt: z.string(),
  // When it became Public: fixes the entry's place in the list until it stops being listed.
  listedAt: z.string(),
  updatedAt: z.string(),
});
export type ExploreEntry = z.infer<typeof ExploreEntrySchema>;

// explore/tours/<tourId>.json: where the tour's entry is, so removal needs only the tourId.
export const ExplorePointerSchema = z.object({
  v: z.literal(1),
  key: z.string().refine((k) => k.startsWith(EXPLORE_INDEX_ROOT)),
});
export type ExplorePointer = z.infer<typeof ExplorePointerSchema>;

// explore/hidden/<tourId>.json: the operator's "hide from Explore" (takedown.ts).
export const ExploreHiddenSchema = z.object({ v: z.literal(1), hiddenAt: z.string() });

/** One card on /explore. */
export const ExploreTourSchema = z.object({
  tourId: publicId(),
  slug: z.string(),
  title: z.string(),
  sceneCount: z.number().int().nonnegative(),
  cover: ExploreCoverSchema.nullable(),
  publishedAt: z.string(),
  updatedAt: z.string(),
});
export type ExploreTour = z.infer<typeof ExploreTourSchema>;

/** GET /api/explore's 200. `cursor` asks for the next page; null on the last one. */
export const ExplorePageSchema = z.object({
  tours: z.array(ExploreTourSchema),
  cursor: z.string().regex(EXPLORE_CURSOR_PATTERN).nullable(),
});
export type ExplorePage = z.infer<typeof ExplorePageSchema>;

// The operator's approval queue (admin app /app/ops/explore): a Public tour is listed
// only once the operator approves it, and again after any change to what it shows.

// explore/approved/<tourId>.json: the bundle the operator approved, by fingerprint.
export const ExploreApprovalSchema = z.object({
  v: z.literal(1),
  approvedAt: z.string(),
  fingerprint: z.string(),
});
export type ExploreApproval = z.infer<typeof ExploreApprovalSchema>;

// explore/pending/<tourId>.json: a tour waiting for approval, as the queue shows it.
export const ExplorePendingSchema = z.object({
  v: z.literal(1),
  tourId: publicId(),
  slug: z.string(),
  title: z.string(),
  sceneCount: z.number().int().nonnegative(),
  cover: ExploreCoverSchema.nullable(),
  // Of the bundle waiting; an approval must name it, so a tour changed since it was
  // looked at isn't approved unseen.
  fingerprint: z.string(),
  // 'changed': it was approved before, and has changed since.
  reason: z.enum(['new', 'changed']),
  // When it first joined the queue; kept while it waits.
  queuedAt: z.string(),
  updatedAt: z.string(),
});
export type ExplorePending = z.infer<typeof ExplorePendingSchema>;

/** admin-api's queue route, behind the operator gate: GET lists it, POST /:tourId decides. */
export const EXPLORE_QUEUE_PATH = '/api/admin/ops/explore';

/** GET {EXPLORE_QUEUE_PATH}: every tour waiting, oldest first. */
export const ExploreQueueSchema = z.object({ tours: z.array(ExplorePendingSchema) });
export type ExploreQueue = z.infer<typeof ExploreQueueSchema>;

/**
 * POST {EXPLORE_QUEUE_PATH}/:tourId. `approve` lists the tour; `reject` hides it from
 * Explore (the Users page's hide), and it stays live by link. Answers the queue as it is now.
 */
export const EXPLORE_DECISIONS = ['approve', 'reject'] as const;
export type ExploreDecision = (typeof EXPLORE_DECISIONS)[number];
export const ExploreDecisionRequestSchema = z.object({
  action: z.enum(EXPLORE_DECISIONS),
  fingerprint: z.string().min(1).max(128),
});
/** 409 when the tour changed (or left the queue) since the operator looked. */
export const EXPLORE_STALE_ERROR = 'tour changed since you looked';
