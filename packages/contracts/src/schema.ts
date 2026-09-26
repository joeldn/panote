import { z } from 'zod';

import { PANO_PATTERN } from './keys.js';

// Angles/fov stay in radians/degrees (matching the viewer,
// packages/viewer/src/types.ts), not the prototype's normalised 0..1
// (decided, docs/wave6-plan.md D12).
//
// All three are canonicalized, not bounded: yaw is deliberately unbounded
// in the viewer (PanoViewer.ts getView:350, panByPixels:292, momentum:392,
// setNorth:242), and pitch/fov are only clamped there on the way in
// (PanoViewer.ts:90-91), never retroactively on a stored value - a legacy
// or hand-edited doc can carry either out of range. So a finite value
// outside range is wrapped/clamped rather than rejected; the api.ts
// response schemas embed these, so this also fixes the editor's load, not
// just save. Only non-finite input (NaN, ±Infinity) is rejected.
const PITCH_MIN = -Math.PI / 2;
const PITCH_MAX = Math.PI / 2;
const FOV_MIN = 15;
const FOV_MAX = 80;

// Copied from packages/viewer/src/camera-math.ts (not imported - contracts
// has no runtime dependency on @panote/viewer). Wraps into (-π, π].
const normalizeAngle = (a: number): number => {
  const TWO_PI = Math.PI * 2;
  const wrapped = a % TWO_PI;
  if (wrapped > Math.PI) return wrapped - TWO_PI;
  if (wrapped <= -Math.PI) return wrapped + TWO_PI;
  return wrapped;
};

const clamp = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v));

// finite() rejects NaN/±Infinity; transform (not preprocess - zod 3's
// preprocess would widen the input type to unknown) then canonicalizes.
const angle = () => z.number().finite().transform(normalizeAngle);
const pitchField = () =>
  z
    .number()
    .finite()
    .transform((v) => clamp(v, PITCH_MIN, PITCH_MAX));
const fovField = () =>
  z
    .number()
    .finite()
    .transform((v) => clamp(v, FOV_MIN, FOV_MAX));

export const ViewSchema = z.object({
  yaw: angle(),
  pitch: pitchField(),
  fov: fovField(),
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
    yaw: angle(),
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
  // Compass north offset, radians - same canonicalization as yaw (D12;
  // viewer's ViewerOptions.north, packages/viewer/src/types.ts).
  north: angle().optional(),
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
