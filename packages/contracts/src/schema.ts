import { z } from 'zod';

export const ViewSchema = z.object({
  yaw: z.number(),
  pitch: z.number(),
  fov: z.number().positive(),
});
export type View = z.infer<typeof ViewSchema>;

export const HotspotSchema = z
  .object({
    id: z.string().min(1),
    type: z.enum(['info', 'link']),
    yaw: z.number(),
    pitch: z.number(),
    title: z.string().min(1),
    body: z.string().optional(),
    targetPanoId: z.string().optional(),
  })
  .refine((h) => h.type !== 'link' || !!h.targetPanoId, {
    message: 'link hotspot requires targetPanoId',
    path: ['targetPanoId'],
  });
export type Hotspot = z.infer<typeof HotspotSchema>;

export const SceneConfigSchema = z.object({
  panoId: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional(),
  initialView: ViewSchema.optional(),
  hotspots: z.array(HotspotSchema).default([]),
});
export type SceneConfig = z.infer<typeof SceneConfigSchema>;

export const TourSceneSchema = z.object({
  panoId: z.string().min(1),
  mapX: z.number().optional(),
  mapY: z.number().optional(),
});
export type TourScene = z.infer<typeof TourSceneSchema>;

export const TourDocSchema = z.object({
  tourId: z.string().min(1),
  title: z.string().min(1),
  scenes: z.array(TourSceneSchema).default([]),
});
export type TourDoc = z.infer<typeof TourDocSchema>;
