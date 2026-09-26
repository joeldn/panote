import { z } from 'zod';

import { PANO_PATTERN } from './keys.js';

// Angles stay in radians (matching the viewer, packages/viewer/src/types.ts),
// not the prototype's normalised 0..1 (decided, docs/wave6-plan.md D12).
const YAW_MIN = -Math.PI;
const YAW_MAX = Math.PI;
const PITCH_MIN = -Math.PI / 2;
const PITCH_MAX = Math.PI / 2;
// Degrees, matching the viewer's default minFov/maxFov (PanoViewer.ts:57-58).
const FOV_MIN = 15;
const FOV_MAX = 80;
const yawField = () => z.number().min(YAW_MIN).max(YAW_MAX);
const pitchField = () => z.number().min(PITCH_MIN).max(PITCH_MAX);

export const ViewSchema = z.object({
  yaw: yawField(),
  pitch: pitchField(),
  fov: z.number().min(FOV_MIN).max(FOV_MAX),
});
export type View = z.infer<typeof ViewSchema>;

// Caps below are additive size bounds (unit B1, 3.6): nothing capped these
// before, and pub bundles multiply per-scene/per-hotspot storage cost.
export const MAX_HOTSPOTS = 200;
export const MAX_HOTSPOT_BODY_LENGTH = 20_000;

// Font Awesome icon name, as rendered by the editor's icon picker.
const ICON_PATTERN = /^[a-z0-9-]{1,40}$/;

export const HotspotMediaSchema = z.object({
  kind: z.enum(['image', 'video', 'youtube']),
  // https only - rendered directly in the viewer/editor, and youtube embeds
  // go through youtube-nocookie.com regardless (id is what that needs).
  url: z
    .string()
    .url()
    .refine((u) => u.startsWith('https://'), 'media url must be https')
    .optional(),
  id: z.string().max(128).optional(),
});
export type HotspotMedia = z.infer<typeof HotspotMediaSchema>;

// targetPanoId ends up in a tile/manifest URL the same way panoId does
// (see SceneConfigSchema below), so it's restricted to PANO_PATTERN too.
export const HotspotSchema = z
  .object({
    id: z.string().min(1),
    type: z.enum(['info', 'link']),
    yaw: yawField(),
    pitch: pitchField(),
    title: z.string().min(1),
    body: z.string().max(MAX_HOTSPOT_BODY_LENGTH).optional(),
    icon: z.string().regex(ICON_PATTERN, `icon must match ${ICON_PATTERN}`).optional(),
    size: z.number().min(0.5).max(3).optional(),
    media: HotspotMediaSchema.optional(),
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
  // Compass north offset, radians - same range as yaw (D12; viewer's
  // ViewerOptions.north, packages/viewer/src/types.ts).
  north: z.number().min(YAW_MIN).max(YAW_MAX).optional(),
  hotspots: z.array(HotspotSchema).max(MAX_HOTSPOTS).default([]),
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

// Tour-wide viewer chrome (design README:113-114). Not i18n - deferred to
// Wave 7 (Q4) - and not per-scene, since it applies across the whole tour.
export const TourSettingsSchema = z.object({
  controls: z.enum(['bottom', 'top']),
  showMap: z.boolean(),
  showCompass: z.boolean(),
  autoRotate: z.boolean(),
});
export type TourSettings = z.infer<typeof TourSettingsSchema>;

// tourId is used verbatim in tourKey(), same reason as panoId above.
export const TourDocSchema = z.object({
  tourId: z.string().regex(PANO_PATTERN, `tourId must match ${PANO_PATTERN}`),
  title: z.string().min(1),
  scenes: z.array(TourSceneSchema).max(MAX_TOUR_SCENES).default([]),
  // Entry scene (design README:113-114); same pattern as TourSceneSchema.panoId.
  startPanoId: z.string().regex(PANO_PATTERN, `startPanoId must match ${PANO_PATTERN}`).optional(),
  settings: TourSettingsSchema.optional(),
});
export type TourDoc = z.infer<typeof TourDocSchema>;
