import { z } from 'zod';

import { PANO_PATTERN } from './keys.js';
import {
  MAX_ID_LENGTH,
  SceneConfigSchema,
  TourSettingsSchema,
  type TourSettings,
} from './schema.js';
import { checkSlug } from './slug.js';

// Stored documents behind share links (plan 3.2). Everything here except
// PublishRecord is public, so none of it may carry an owner id or key.

export const VISIBILITIES = ['public', 'unlisted'] as const;
export const VisibilitySchema = z.enum(VISIBILITIES);
export type Visibility = z.infer<typeof VisibilitySchema>;
// Q3: a tour is live by link from its first publish, unlisted by default.
export const DEFAULT_VISIBILITY: Visibility = 'unlisted';

// Used when a tour has never saved settings; mirrors the design's defaults
// (controls at the bottom, mini-map and compass shown).
export const DEFAULT_TOUR_SETTINGS: TourSettings = {
  controls: 'bottom',
  showMap: true,
  showCompass: true,
  autoRotate: false,
};

export const SlugSchema = z.string().superRefine((s, ctx) => {
  const check = checkSlug(s);
  if (!check.ok) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${check.reason} slug` });
});

// Public readers build tile/manifest URLs from these ids, so they get the same check as a TourDoc.
const publicId = () => z.string().regex(PANO_PATTERN).max(MAX_ID_LENGTH);

// pub/tours/<tourId>.json
export const PublishedTourSchema = z.object({
  v: z.literal(1),
  tourId: publicId(),
  title: z.string(),
  visibility: VisibilitySchema,
  slug: z.string(),
  publishedAt: z.string(),
  settings: TourSettingsSchema,
  startPanoId: publicId(),
  scenes: z.array(
    z
      .object({
        panoId: publicId(),
        mapX: z.number().optional(),
        mapY: z.number().optional(),
        config: SceneConfigSchema,
      })
      .refine((s) => s.config.panoId === s.panoId, {
        message: "config.panoId must match the scene's panoId",
        path: ['config', 'panoId'],
      }),
  ),
});
export type PublishedTour = z.infer<typeof PublishedTourSchema>;

// slugs/<slug>.json: a live pointer, or a time-limited alias left behind by
// a slug change (Q6). The website Worker turns an alias into a 308.
export const SlugPointerSchema = z.object({
  v: z.literal(1),
  kind: z.literal('tour'),
  tourId: z.string(),
});
export const SlugRedirectSchema = z.object({
  v: z.literal(1),
  kind: z.literal('redirect'),
  tourId: z.string(),
  redirect: z.string(),
  expiresAt: z.string(),
});
export const SlugRecordSchema = z.discriminatedUnion('kind', [
  SlugPointerSchema,
  SlugRedirectSchema,
]);
export type SlugPointer = z.infer<typeof SlugPointerSchema>;
export type SlugRedirect = z.infer<typeof SlugRedirectSchema>;
export type SlugRecord = z.infer<typeof SlugRecordSchema>;

// tours/<owner>/<tourId>/publish.json (private). `aliases` lists this tour's
// earlier slugs so a rename chain can be collapsed onto the newest slug.
export const PublishRecordSchema = z.object({
  slug: z.string(),
  visibility: VisibilitySchema,
  publishedAt: z.string(),
  aliases: z.array(z.string()).optional(),
});
export type PublishRecord = z.infer<typeof PublishRecordSchema>;
