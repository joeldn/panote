import { z } from 'zod';

import { TILE_FORMATS } from './manifest.js';
import { VisibilitySchema } from './publish.js';
import { SceneConfigSchema, TourDocSchema } from './schema.js';

// Response schemas for admin-api's owner GET routes; web-kit validates
// responses against these.

export const PanoConfigOkSchema = z.object({
  config: SceneConfigSchema,
  etag: z.string(),
});
export type PanoConfigOk = z.infer<typeof PanoConfigOkSchema>;

// Lets the UI tell a tombstoned pano apart from one whose config was
// simply never written, for the same missing-config 404.
export const PanoConfigNotFoundSchema = z.object({
  error: z.literal('config not found'),
  deleting: z.boolean(),
  hasOriginal: z.boolean(),
});
export type PanoConfigNotFound = z.infer<typeof PanoConfigNotFoundSchema>;

export const TourMissingConfigSchema = z.object({
  missing: z.literal(true),
  deleting: z.boolean(),
  hasOriginal: z.boolean(),
});
export type TourMissingConfig = z.infer<typeof TourMissingConfigSchema>;

export const TourConfigEntrySchema = z.union([PanoConfigOkSchema, TourMissingConfigSchema]);
export type TourConfigEntry = z.infer<typeof TourConfigEntrySchema>;

// The tour's share-link state (from its private publish.json), null when unpublished.
export const TourPublishStateSchema = z.object({
  slug: z.string(),
  visibility: VisibilitySchema,
  publishedAt: z.string(),
});
export type TourPublishState = z.infer<typeof TourPublishStateSchema>;

export const TourOkSchema = z.object({
  tour: TourDocSchema,
  etag: z.string(),
  publish: TourPublishStateSchema.nullable(),
});
export type TourOk = z.infer<typeof TourOkSchema>;

export const TourWithConfigsOkSchema = TourOkSchema.extend({
  configs: z.record(z.string(), TourConfigEntrySchema),
});
export type TourWithConfigsOk = z.infer<typeof TourWithConfigsOkSchema>;

export const TourNotFoundSchema = z.object({ error: z.literal('not found') });
export type TourNotFound = z.infer<typeof TourNotFoundSchema>;

// --- Lists, summaries and pano status (unit A2) ---

// Same order the tiling-status rule checks in: ready beats failed beats
// pending, so a same-etag race never shows a successfully tiled pano as failed.
export const TilingStatusSchema = z.enum(['ready', 'pending', 'failed', 'none']);
export type TilingStatus = z.infer<typeof TilingStatusSchema>;

// Loosely typed vs. ManifestSchema: this is read from our own tiler output,
// not re-validated, the same trust level tiler-consumer's own reads use.
export const PanoManifestSummarySchema = z.object({
  version: z.string().optional(),
  format: z.enum(TILE_FORMATS),
  tileSize: z.number().int().positive(),
});
export type PanoManifestSummary = z.infer<typeof PanoManifestSummarySchema>;

export const PanoSummarySchema = z.object({
  panoId: z.string(),
  title: z.string().nullable(),
  hasConfig: z.boolean(),
  hasOriginal: z.boolean(),
  deleting: z.boolean(),
  tiling: TilingStatusSchema,
  manifest: PanoManifestSummarySchema.nullable(),
  updatedAt: z.string(),
});
export type PanoSummary = z.infer<typeof PanoSummarySchema>;

export const PanosListOkSchema = z.object({
  panoIds: z.array(z.string()),
  panos: z.array(PanoSummarySchema),
  cursor: z.string().nullable(),
});
export type PanosListOk = z.infer<typeof PanosListOkSchema>;

// The pano GET's `status` field: PanoSummary minus the two fields already
// known from the surrounding response (panoId from the URL, title from config).
export const PanoStatusSchema = PanoSummarySchema.omit({ panoId: true, title: true });
export type PanoStatus = z.infer<typeof PanoStatusSchema>;

// A separate schema from PanoConfigOkSchema: TourConfigEntrySchema still
// uses the bare {config, etag} shape for ?include=configs, unaffected here.
export const PanoWithStatusOkSchema = PanoConfigOkSchema.extend({ status: PanoStatusSchema });
export type PanoWithStatusOk = z.infer<typeof PanoWithStatusOkSchema>;

export const PanoStatusOnlyOkSchema = z.object({ status: PanoStatusSchema });
export type PanoStatusOnlyOk = z.infer<typeof PanoStatusOnlyOkSchema>;

export const TourPublishSummarySchema = z.object({
  slug: z.string(),
  visibility: VisibilitySchema,
});
export type TourPublishSummary = z.infer<typeof TourPublishSummarySchema>;

export const TourSummarySchema = z.object({
  tourId: z.string(),
  title: z.string(),
  sceneCount: z.number().int().nonnegative(),
  coverPanoId: z.string().nullable(),
  updatedAt: z.string(),
  etag: z.string(),
  // From publish.json's customMetadata, grouped in by tourId; null when unpublished.
  publish: TourPublishSummarySchema.nullable(),
});
export type TourSummary = z.infer<typeof TourSummarySchema>;

export const ToursListOkSchema = z.object({
  tours: z.array(TourSummarySchema),
  cursor: z.string().nullable(),
});
export type ToursListOk = z.infer<typeof ToursListOkSchema>;

// --- Publish, slugs, visibility (unit B2) ---

export const PublishRequestSchema = z.object({
  visibility: VisibilitySchema.optional(),
  slug: z.string().optional(),
});
export type PublishRequest = z.infer<typeof PublishRequestSchema>;

export const PublishOkSchema = z.object({
  slug: z.string(),
  visibility: VisibilitySchema,
  url: z.string(),
  publishedAt: z.string(),
});
export type PublishOk = z.infer<typeof PublishOkSchema>;

export const PUBLISH_FAILURE_REASONS = ['missing', 'deleting', 'not-owned', 'not-ready'] as const;
export const PublishFailureReasonSchema = z.enum(PUBLISH_FAILURE_REASONS);
export type PublishFailureReason = z.infer<typeof PublishFailureReasonSchema>;

// 422: every scene that failed its ownership/readiness check, not just the first.
export const PublishUnprocessableSchema = z.object({
  error: z.enum(['scenes not publishable', 'tour has no scenes']),
  scenes: z.array(z.object({ panoId: z.string(), reason: PublishFailureReasonSchema })),
});
export type PublishUnprocessable = z.infer<typeof PublishUnprocessableSchema>;

export const SlugTakenSchema = z.object({ error: z.literal('slug taken') });
export const SlugInvalidSchema = z.object({ error: z.enum(['invalid slug', 'reserved slug']) });
// 409 when a concurrent publish, rename or visibility change got there first; retry.
export const PublishConflictSchema = z.object({ error: z.literal('conflict') });
export const NotPublishedSchema = z.object({ error: z.literal('not published') });

export const SlugPutRequestSchema = z.object({ slug: z.string() });
export const SlugPutOkSchema = z.object({
  slug: z.string(),
  // When the previous slug stops redirecting; null when the slug didn't change.
  oldSlugRedirectsUntil: z.string().nullable(),
});
export type SlugPutOk = z.infer<typeof SlugPutOkSchema>;

export const VisibilityPatchRequestSchema = z.object({ visibility: VisibilitySchema });
export const VisibilityOkSchema = z.object({ visibility: VisibilitySchema });
export type VisibilityOk = z.infer<typeof VisibilityOkSchema>;
