import { z } from 'zod';

import { SceneConfigSchema, TourDocSchema } from './schema.js';

// Response schemas for admin-api's owner GET routes; web-kit validates
// responses against these. List/summary/publish fields aren't added yet.

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
