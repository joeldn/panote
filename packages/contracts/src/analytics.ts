import { z } from 'zod';

import { PANO_PATTERN } from './keys.js';
import { MAX_ID_LENGTH } from './schema.js';

// Anonymous viewer analytics (unit B5). Bodies carry content ids only;
// public-api builds each data point field by field, so extra keys never land.

export const ANALYTICS_SURFACES = ['page', 'embed'] as const;
export type AnalyticsSurface = (typeof ANALYTICS_SURFACES)[number];

export const ANALYTICS_EVENT_TYPES = ['scene', 'hotspot', 'dwell'] as const;
export type AnalyticsEventType = (typeof ANALYTICS_EVENT_TYPES)[number];

export const MAX_EVENTS_PER_BATCH = 20;
export const MAX_DWELL_MS = 4 * 60 * 60 * 1000;
export const ANALYTICS_SCHEMA_VERSION = 'v1';

// Stricter than HotspotSchema's id: it's written into AE blobs verbatim.
export const ANALYTICS_HOTSPOT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

// Also the AE index, which is capped at 96 bytes.
export const AnalyticsContentIdSchema = z
  .string()
  .max(MAX_ID_LENGTH)
  .regex(PANO_PATTERN, `id must match ${PANO_PATTERN}`);

export const ViewBeaconSchema = z.object({
  panoId: AnalyticsContentIdSchema.optional(),
  surface: z.enum(ANALYTICS_SURFACES).optional(),
});
export type ViewBeacon = z.infer<typeof ViewBeaconSchema>;

export const AnalyticsEventSchema = z
  .object({
    type: z.enum(ANALYTICS_EVENT_TYPES),
    panoId: AnalyticsContentIdSchema.optional(),
    hotspotId: z
      .string()
      .regex(ANALYTICS_HOTSPOT_ID_PATTERN, `hotspotId must match ${ANALYTICS_HOTSPOT_ID_PATTERN}`)
      .optional(),
    ms: z.number().finite().optional(),
    surface: z.enum(ANALYTICS_SURFACES).optional(),
  })
  .superRefine((e, ctx) => {
    const need = (field: 'panoId' | 'hotspotId' | 'ms') => {
      if (e[field] === undefined) {
        ctx.addIssue({ code: 'custom', path: [field], message: `${e.type} events need ${field}` });
      }
    };
    if (e.type === 'dwell') need('ms');
    if (e.type === 'scene' || e.type === 'hotspot') need('panoId');
    if (e.type === 'hotspot') need('hotspotId');
  });
export type AnalyticsEvent = z.infer<typeof AnalyticsEventSchema>;

export const AnalyticsEventBatchSchema = z.object({
  events: z.array(AnalyticsEventSchema).max(MAX_EVENTS_PER_BATCH),
});
export type AnalyticsEventBatch = z.infer<typeof AnalyticsEventBatchSchema>;
