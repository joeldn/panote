import { z } from 'zod';

import { PANO_PATTERN } from './keys.js';

export const ViewSchema = z.object({
  yaw: z.number(),
  pitch: z.number(),
  fov: z.number().positive(),
});
export type View = z.infer<typeof ViewSchema>;

// targetPanoId ends up in a tile/manifest URL the same way panoId does
// (see SceneConfigSchema below), so it's restricted to PANO_PATTERN too.
export const HotspotSchema = z
  .object({
    id: z.string().min(1),
    type: z.enum(['info', 'link']),
    yaw: z.number(),
    pitch: z.number(),
    title: z.string().min(1),
    body: z.string().optional(),
    targetPanoId: z
      .string()
      .regex(PANO_PATTERN, `targetPanoId must match ${PANO_PATTERN}`)
      .optional(),
  })
  .refine((h) => h.type !== 'link' || !!h.targetPanoId, {
    message: 'link hotspot requires targetPanoId',
    path: ['targetPanoId'],
  });
export type Hotspot = z.infer<typeof HotspotSchema>;

// panoId stays verbatim in the R2 key because the viewer builds URLs from
// the manifest's raw pano value (see keys.ts). Validating it here at the
// schema boundary is what makes that verbatim use safe.
export const SceneConfigSchema = z.object({
  panoId: z.string().regex(PANO_PATTERN, `panoId must match ${PANO_PATTERN}`),
  title: z.string().min(1),
  description: z.string().optional(),
  initialView: ViewSchema.optional(),
  hotspots: z.array(HotspotSchema).default([]),
});
export type SceneConfig = z.infer<typeof SceneConfigSchema>;

// Same reason as SceneConfigSchema.panoId above.
export const TourSceneSchema = z.object({
  panoId: z.string().regex(PANO_PATTERN, `panoId must match ${PANO_PATTERN}`),
  mapX: z.number().optional(),
  mapY: z.number().optional(),
});
export type TourScene = z.infer<typeof TourSceneSchema>;

// Bounds a tour's own R2 read/write cost (e.g. admin-api's ?include=configs
// scene fan-out); also used as a defensive cap on the read side.
export const MAX_TOUR_SCENES = 100;

// tourId is used verbatim in tourKey(), same reason as panoId above.
export const TourDocSchema = z.object({
  tourId: z.string().regex(PANO_PATTERN, `tourId must match ${PANO_PATTERN}`),
  title: z.string().min(1),
  scenes: z.array(TourSceneSchema).max(MAX_TOUR_SCENES).default([]),
});
export type TourDoc = z.infer<typeof TourDocSchema>;
