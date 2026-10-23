import { z } from 'zod';

import { PANO_PATTERN } from './keys.js';
import { MAX_ID_LENGTH } from './schema.js';

// Flags on a panorama: a visitor's report from the tour page (public-api), kept for the
// operator's review queue (admin app /app/ops/flags). Private, under moderation/ (outside
// the CDN WAF's public prefixes), and owner-free: a flag names the tour and the pano,
// never who owns them or who sent it.

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

// moderation/flags/<rank>-<flagId>.json, newest first (see keys.ts flagKey).
export const FlagRecordSchema = z.object({
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
