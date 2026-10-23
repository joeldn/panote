import { z } from 'zod';

import { TourPublishSummarySchema } from './api.js';

// The operator's support pages (admin app /app/ops/users, admin-api /api/admin/ops/users):
// find the account a message is about, see what it holds, and make the few changes the
// operator scripts make, from a browser. Behind the operator gate (OPERATOR_SUB_SHA256);
// every write also needs a recent sign-in (REAUTH_REQUIRED_ERROR).

export const SUPPORT_USERS_PATH = '/api/admin/ops/users';

/** Longest lookup query, and the longest sub a path may name (Auth0 ids are far shorter). */
export const SUPPORT_QUERY_MAX = 512;

/** GET {SUPPORT_USERS_PATH}/lookup?q=: what `q` named, and whose it is. */
export const SupportLookupOkSchema = z.object({
  sub: z.string(),
  /** How `q` was read: an account ID, a share link or slug, or a tourId. */
  via: z.enum(['sub', 'slug', 'tour']),
  tourId: z.string().nullable(),
});
export type SupportLookupOk = z.infer<typeof SupportLookupOkSchema>;

export const SupportTourSchema = z.object({
  tourId: z.string(),
  title: z.string(),
  sceneCount: z.number().int().nonnegative(),
  updatedAt: z.string(),
  publish: TourPublishSummarySchema.nullable(),
  hiddenFromExplore: z.boolean(),
  editors: z.number().int().nonnegative(),
  transferring: z.boolean(),
});
export type SupportTour = z.infer<typeof SupportTourSchema>;

export const SupportTrashItemSchema = z.object({
  /** The trash day (YYYY-MM-DD) the original was deleted on, as restore takes it. */
  date: z.string(),
  /** The original's own key (panos/<owner>/<panoId>/original). */
  key: z.string(),
  panoId: z.string(),
  bytes: z.number().int().nonnegative(),
});
export type SupportTrashItem = z.infer<typeof SupportTrashItemSchema>;

/** GET {SUPPORT_USERS_PATH}/:sub: one account, everything support needs on one page. */
export const SupportUserViewSchema = z.object({
  sub: z.string(),
  /** When admin-api first saw the account (since.json), if it has. */
  since: z.string().nullable(),
  disabled: z.object({ disabledAt: z.string(), reason: z.string().optional() }).nullable(),
  deletion: z.object({ requestedAt: z.string(), completedAt: z.string().optional() }).nullable(),
  usage: z.object({
    panos: z.number().int().nonnegative(),
    bytes: z.number().int().nonnegative(),
    uploadsToday: z.number().int().nonnegative(),
    tours: z.number().int().nonnegative(),
  }),
  limits: z.object({
    maxPanos: z.number().int().nullable(),
    maxBytes: z.number().int().nullable(),
    maxTours: z.number().int(),
  }),
  tours: z.array(SupportTourSchema),
  /** Tours the account edits for someone else, by id. */
  editsTours: z.array(z.string()),
  /** Originals the account deleted that can still be restored, newest day first. */
  trash: z.array(SupportTrashItemSchema),
});
export type SupportUserView = z.infer<typeof SupportUserViewSchema>;

/** POST {SUPPORT_USERS_PATH}/:sub/disable. */
export const SupportDisableRequestSchema = z.object({
  reason: z.string().trim().min(1).max(200),
});

/** POST {SUPPORT_USERS_PATH}/:sub/tours/:tourId: the takedown actions short of a delete. */
export const SUPPORT_TOUR_ACTIONS = ['unpublish', 'hide', 'unhide'] as const;
export type SupportTourAction = (typeof SUPPORT_TOUR_ACTIONS)[number];
export const SupportTourActionRequestSchema = z.object({
  action: z.enum(SUPPORT_TOUR_ACTIONS),
});

/** POST {SUPPORT_USERS_PATH}/:sub/restore: one original back from the trash. */
export const SupportRestoreRequestSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  panoId: z.string(),
});

/** POST {SUPPORT_USERS_PATH}/:sub/close: marks the account for deletion; `confirm` repeats the sub. */
export const SupportCloseRequestSchema = z.object({ confirm: z.string() });

/** What every support write answers: the account as it is now. */
export type SupportActionOk = SupportUserView;
