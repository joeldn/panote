import { z } from 'zod';

import { PANO_PATTERN } from './keys.js';
import { MAX_ID_LENGTH } from './schema.js';

// Flags on a panorama, kept for the operator's review queue (admin app /app/ops/flags).
// Private, under moderation/ (outside the CDN WAF's public prefixes). Two sources:
// - a visitor's report from the tour page (public-api). Owner-free: it names the tour and
//   the pano, never who owns them or who sent it.
// - the automatic check of every newly tiled panorama (tiler-consumer screen.ts). It names
//   the uploader's account, since the pano may be in no tour, and nothing else could lead
//   the operator to its owner.

const publicId = () => z.string().regex(PANO_PATTERN).max(MAX_ID_LENGTH);

/** Why a visitor flags a panorama, in the order the tour page offers them. */
export const FLAG_REASONS = [
  'sexual',
  'child-safety',
  'violence',
  'hate',
  'illegal',
  'privacy',
  'copyright',
  'spam',
  'other',
] as const;
export type FlagReason = (typeof FLAG_REASONS)[number];

/** Longest note a visitor may add to a flag. */
export const MAX_FLAG_NOTE_LENGTH = 500;

/** public-api's route: POST /api/tours/:tourId/flag. */
export const flagPath = (tourId: string): string => `/api/tours/${tourId}/flag`;

export const FlagRequestSchema = z.object({
  panoId: publicId(),
  reason: z.enum(FLAG_REASONS),
  note: z.string().trim().max(MAX_FLAG_NOTE_LENGTH).optional(),
});
export type FlagRequest = z.infer<typeof FlagRequestSchema>;

/** What the automatic check looks for: the visitor reasons a photo alone can show. */
export const SCREEN_CATEGORIES = [
  'sexual',
  'child-safety',
  'violence',
  'hate',
] as const satisfies readonly FlagReason[];
export type ScreenCategory = (typeof SCREEN_CATEGORIES)[number];
/** Categories that also email the operator straight away. */
export const SEVERE_SCREEN_CATEGORIES: readonly ScreenCategory[] = ['sexual', 'child-safety'];
/** Longest account id a screening flag keeps (Auth0 subs are far shorter). */
const MAX_OWNER_LENGTH = 256;
/** Longest reason kept from the automatic check. */
export const MAX_SCREEN_SUMMARY_LENGTH = 300;

// moderation/flags/<rank>-<flagId>.json, newest first (see keys.ts flagKey).
export const ViewerFlagSchema = z.object({
  v: z.literal(1),
  flagId: publicId(),
  source: z.literal('viewer'),
  tourId: publicId(),
  // The tour's slug when it was flagged, so the queue can link to it.
  slug: z.string(),
  panoId: publicId(),
  reason: z.enum(FLAG_REASONS),
  note: z.string().optional(),
  at: z.string(),
});
export type ViewerFlag = z.infer<typeof ViewerFlagSchema>;

export const ScreeningFlagSchema = z.object({
  v: z.literal(1),
  flagId: publicId(),
  source: z.literal('screening'),
  panoId: publicId(),
  // The manifest version checked, so the queue shows that image even after a replacement.
  version: z.string().max(MAX_ID_LENGTH),
  // The uploader's account id (sub), for the Users page.
  owner: z.string().min(1).max(MAX_OWNER_LENGTH),
  categories: z.array(z.enum(SCREEN_CATEGORIES)).min(1),
  summary: z.string().max(MAX_SCREEN_SUMMARY_LENGTH).optional(),
  at: z.string(),
});
export type ScreeningFlag = z.infer<typeof ScreeningFlagSchema>;

export const FlagRecordSchema = z.discriminatedUnion('source', [
  ViewerFlagSchema,
  ScreeningFlagSchema,
]);
export type FlagRecord = z.infer<typeof FlagRecordSchema>;

/** admin-api's review route, behind the operator gate. */
export const FLAGS_PATH = '/api/admin/ops/flags';
/** Flags one GET reads at most, newest first. */
export const FLAGS_PAGE_MAX = 200;

/** GET {FLAGS_PATH}: the newest flags; `more` when older ones are left unread. */
export const FlagListSchema = z.object({
  flags: z.array(FlagRecordSchema),
  more: z.boolean(),
});
export type FlagList = z.infer<typeof FlagListSchema>;

/** POST {FLAGS_PATH}/dismiss: deletes these flags; answers the list as it is now. */
export const FlagDismissRequestSchema = z.object({
  flagIds: z.array(publicId()).min(1).max(FLAGS_PAGE_MAX),
});
