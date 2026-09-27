import { z } from 'zod';

import { TILE_FORMATS } from './manifest.js';
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

export const TourOkSchema = z.object({
  tour: TourDocSchema,
  etag: z.string(),
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
  visibility: z.enum(['public', 'unlisted']),
});
export type TourPublishSummary = z.infer<typeof TourPublishSummarySchema>;

export const TourSummarySchema = z.object({
  tourId: z.string(),
  title: z.string(),
  sceneCount: z.number().int().nonnegative(),
  coverPanoId: z.string().nullable(),
  updatedAt: z.string(),
  etag: z.string(),
  // Always null until unit B2 writes publish.json; the list route already
  // groups it in by tourId so B2 needs no read-path change.
  publish: TourPublishSummarySchema.nullable(),
});
export type TourSummary = z.infer<typeof TourSummarySchema>;

export const ToursListOkSchema = z.object({
  tours: z.array(TourSummarySchema),
  cursor: z.string().nullable(),
});
export type ToursListOk = z.infer<typeof ToursListOkSchema>;
