import { z } from 'zod';

import { PANO_PATTERN, PLAN_IMAGE_TYPES, type PlanImageType } from './keys.js';
import { LanguageTagSchema, MAX_TOUR_LANGUAGES, TourLanguagesSchema } from './languages.js';
import { MAX_PLAN_EDGE } from './plan.js';

// Radians/degrees, canonicalized not bounded: the viewer's yaw is unbounded
// (PanoViewer.ts panByPixels:292) and pitch/fov clamp only on setView (:344-346).
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
// Shared by scene/hotspot/tour titles - the same kind of short display field.
export const MAX_TITLE_LENGTH = 200;
export const MAX_SCENE_DESCRIPTION_LENGTH = 2000;
// A tour's description is its link-preview and search snippet. Previews show
// roughly the first 155-200 characters; 300 leaves room for a second sentence.
export const MAX_TOUR_DESCRIPTION_LENGTH = 300;
export const MAX_HOTSPOT_ID_LENGTH = 64;
// A doc already over a cap (legacy or hand-written) fails to parse on
// load; admin-api does not truncate on read to make it fit.
export const MAX_ID_LENGTH = 64;

// Translations (Q4) sit beside the text they translate, keyed by language tag: a
// hotspot's live in the hotspot, so deleting or duplicating it carries them along and
// nothing can point at an id that is gone. Each string has the same cap as the field it
// translates, and a missing (or absent) entry falls back to the default-language text.
// The default language never appears as a key: its text is the field itself.
const translations = <T extends z.ZodRawShape>(fields: T, max = MAX_TOUR_LANGUAGES - 1) =>
  z
    .record(LanguageTagSchema, z.object(fields))
    .refine((r) => Object.keys(r).length <= max, { message: `at most ${max} translations` });

/**
 * A scene config is per pano, and a pano can be in several tours with different
 * languages, so its translations can cover more languages than one tour has (removing a
 * language from a tour leaves them, for the other tours). Its maps get this wider bound;
 * size is held by MAX_SCENE_TRANSLATION_CHARS, and publish sends only the tour's own.
 */
export const MAX_CONFIG_TRANSLATION_LANGUAGES = 40;

/**
 * All translated text in one scene config (its own and its hotspots') is capped
 * together, so translations add a bounded amount to a config and to the pub bundle
 * that embeds it, whatever the number of languages or points.
 */
export const MAX_SCENE_TRANSLATION_CHARS = 200_000;

const translatedChars = (
  i18n:
    Partial<Record<string, Partial<Record<string, string | undefined>> | undefined>> | undefined,
) =>
  Object.values(i18n ?? {}).reduce(
    (n, entry) => n + Object.values(entry ?? {}).reduce((m, v) => m + (v?.length ?? 0), 0),
    0,
  );

/** Translated characters in a scene config, its own and its hotspots' (see the cap above). */
export const sceneTranslationChars = (c: {
  i18n?: Parameters<typeof translatedChars>[0];
  hotspots: ReadonlyArray<{ i18n?: Parameters<typeof translatedChars>[0] }>;
}): number => translatedChars(c.i18n) + c.hotspots.reduce((n, h) => n + translatedChars(h.i18n), 0);

// Font Awesome icon name, as rendered by the editor's icon picker.
const ICON_PATTERN = /^[a-z0-9-]{1,40}$/;

export const MAX_MEDIA_URL_LENGTH = 2048;
// A YouTube video id is always exactly 11 base64url-ish characters.
const YOUTUBE_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
// Vimeo video ids are numeric; an unlisted video also needs its share hash
// (`vimeo.com/<id>/<hash>` or `?h=<hash>`), 10 lower-case hex characters.
const VIMEO_ID_PATTERN = /^\d{1,15}$/;
export const VIMEO_HASH_PATTERN = /^[0-9a-f]{10}$/;

// Panote only links to media, never hosts it, so the url is any https page or
// file. Parsed, not prefix-matched: the scheme is case-insensitive, and a url
// carrying credentials (https://user:pass@host) is a phishing shape, not media.
// Exported for the viewer to hold hand-built media to the same rule.
export const isHttpsMediaUrl = (u: string): boolean => {
  try {
    const url = new URL(u);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    return false;
  }
};

const mediaUrl = () =>
  z
    .string()
    .trim()
    .url()
    .max(MAX_MEDIA_URL_LENGTH)
    .refine(isHttpsMediaUrl, 'media url must be https');

// Discriminated on kind: image/audio/video/link require url; youtube requires id
// (rendered via youtube-nocookie.com); vimeo requires id, plus hash when unlisted.
export const HotspotMediaSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('image'), url: mediaUrl() }),
  z.object({ kind: z.literal('audio'), url: mediaUrl() }),
  z.object({ kind: z.literal('video'), url: mediaUrl() }),
  z.object({ kind: z.literal('link'), url: mediaUrl() }),
  z.object({
    kind: z.literal('youtube'),
    id: z.string().regex(YOUTUBE_ID_PATTERN, `id must match ${YOUTUBE_ID_PATTERN}`),
  }),
  z.object({
    kind: z.literal('vimeo'),
    id: z.string().regex(VIMEO_ID_PATTERN, `id must match ${VIMEO_ID_PATTERN}`),
    hash: z.string().regex(VIMEO_HASH_PATTERN, `hash must match ${VIMEO_HASH_PATTERN}`).optional(),
  }),
]);
export type HotspotMedia = z.infer<typeof HotspotMediaSchema>;

// targetPanoId ends up in a tile/manifest URL the same way panoId does
// (see SceneConfigSchema below), so it's restricted to PANO_PATTERN too.
export const HotspotSchema = z
  .object({
    id: z.string().min(1).max(MAX_HOTSPOT_ID_LENGTH),
    type: z.enum(['info', 'link']),
    yaw: angle(),
    pitch: pitchField(),
    title: z.string().min(1).max(MAX_TITLE_LENGTH),
    body: z.string().max(MAX_HOTSPOT_BODY_LENGTH).optional(),
    icon: z.string().regex(ICON_PATTERN, `icon must match ${ICON_PATTERN}`).optional(),
    size: z.number().min(0.5).max(3).optional(),
    media: HotspotMediaSchema.optional(),
    targetPanoId: z
      .string()
      .regex(PANO_PATTERN, `targetPanoId must match ${PANO_PATTERN}`)
      .max(MAX_ID_LENGTH)
      .optional(),
    i18n: translations(
      {
        title: z.string().min(1).max(MAX_TITLE_LENGTH).optional(),
        body: z.string().min(1).max(MAX_HOTSPOT_BODY_LENGTH).optional(),
      },
      MAX_CONFIG_TRANSLATION_LANGUAGES,
    ).optional(),
  })
  .refine((h) => h.type !== 'link' || !!h.targetPanoId, {
    message: 'link hotspot requires targetPanoId',
    path: ['targetPanoId'],
  });
export type Hotspot = z.infer<typeof HotspotSchema>;

// panoId stays verbatim in the R2 key because the viewer builds URLs from
// the manifest's raw pano value (see keys.ts). Validating it here at the
// schema boundary is what makes that verbatim use safe.
export const SceneConfigSchema = z
  .object({
    panoId: z.string().regex(PANO_PATTERN, `panoId must match ${PANO_PATTERN}`).max(MAX_ID_LENGTH),
    title: z.string().min(1).max(MAX_TITLE_LENGTH),
    description: z.string().max(MAX_SCENE_DESCRIPTION_LENGTH).optional(),
    initialView: ViewSchema.optional(),
    // Compass north offset, radians - same canonicalization as yaw (D12;
    // viewer's ViewerOptions.north, packages/viewer/src/types.ts).
    north: angle().optional(),
    hotspots: z.array(HotspotSchema).max(MAX_HOTSPOTS).default([]),
    i18n: translations(
      {
        title: z.string().min(1).max(MAX_TITLE_LENGTH).optional(),
        description: z.string().min(1).max(MAX_SCENE_DESCRIPTION_LENGTH).optional(),
      },
      MAX_CONFIG_TRANSLATION_LANGUAGES,
    ).optional(),
  })
  .refine((c) => sceneTranslationChars(c) <= MAX_SCENE_TRANSLATION_CHARS, {
    message: `translations exceed ${MAX_SCENE_TRANSLATION_CHARS} characters`,
    path: ['i18n'],
  });
export type SceneConfig = z.infer<typeof SceneConfigSchema>;

// Same reason as SceneConfigSchema.panoId above.
// mapX/mapY: where the scene sits on the floor plan, 0..1 fractions of it (plan.ts).
// Any finite number still parses, so tours saved before that convention stay valid.
export const TourSceneSchema = z.object({
  panoId: z.string().regex(PANO_PATTERN, `panoId must match ${PANO_PATTERN}`).max(MAX_ID_LENGTH),
  mapX: z.number().finite().optional(),
  mapY: z.number().finite().optional(),
});
export type TourScene = z.infer<typeof TourSceneSchema>;

// The floor-plan image behind the mini-map's dots, at planKey(tourId, id, type) (keys.ts).
// The key is built from the tour's own id, so a tour can only point at its own plans.
const planEdge = () => z.number().int().min(1).max(MAX_PLAN_EDGE);
export const TourPlanSchema = z.object({
  id: z.string().regex(PANO_PATTERN, `plan id must match ${PANO_PATTERN}`).max(MAX_ID_LENGTH),
  type: z.enum(PLAN_IMAGE_TYPES as [PlanImageType, ...PlanImageType[]]),
  width: planEdge(),
  height: planEdge(),
});
export type TourPlan = z.infer<typeof TourPlanSchema>;

// Bounds a tour's own R2 read/write cost (e.g. admin-api's ?include=configs
// scene fan-out); also used as a defensive cap on the read side.
export const MAX_TOUR_SCENES = 100;

// Most tours one owner may hold (admin-api's POST /tours refuses the next one).
export const MAX_TOURS_PER_OWNER = 200;

// Plain text: C0 control characters and DEL are refused, except tab and line breaks.
const isPlainText = (s: string): boolean => {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if ((c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) || c === 0x7f) return false;
  }
  return true;
};

/** Trimmed plain text, shown as-is (never as markup) in link previews and the admin. */
export const TourDescriptionSchema = z
  .string()
  .trim()
  .max(MAX_TOUR_DESCRIPTION_LENGTH)
  .refine(isPlainText, 'description must be plain text');

// Tour-wide viewer chrome (design README:113-114). Not per-scene, since it applies
// across the whole tour.
export const TourSettingsSchema = z.object({
  controls: z.enum(['bottom', 'top']),
  showMap: z.boolean(),
  showCompass: z.boolean(),
  autoRotate: z.boolean(),
});
export type TourSettings = z.infer<typeof TourSettingsSchema>;

/** A tour's own translations (title, description); the published bundle uses it too. */
export const TourTranslationsSchema = translations({
  title: z.string().min(1).max(MAX_TITLE_LENGTH).optional(),
  description: TourDescriptionSchema.pipe(z.string().min(1)).optional(),
});

// tourId is used verbatim in tourKey(), same reason as panoId above.
export const TourDocSchema = z.object({
  tourId: z.string().regex(PANO_PATTERN, `tourId must match ${PANO_PATTERN}`).max(MAX_ID_LENGTH),
  title: z.string().min(1).max(MAX_TITLE_LENGTH),
  // Optional, so tours saved before it existed still parse; published on the next publish.
  description: TourDescriptionSchema.optional(),
  scenes: z.array(TourSceneSchema).max(MAX_TOUR_SCENES).default([]),
  // Entry scene (design README:113-114); same pattern as TourSceneSchema.panoId.
  // Consumers fall back to scenes[0] when startPanoId isn't in scenes.
  startPanoId: z
    .string()
    .regex(PANO_PATTERN, `startPanoId must match ${PANO_PATTERN}`)
    .max(MAX_ID_LENGTH)
    .optional(),
  settings: TourSettingsSchema.optional(),
  // Optional: most tours have no plan image; the mini-map then shows the dots alone.
  plan: TourPlanSchema.optional(),
  // Optional: a tour without it has one, unnamed language (Q4).
  languages: TourLanguagesSchema.optional(),
  i18n: TourTranslationsSchema.optional(),
});
export type TourDoc = z.infer<typeof TourDocSchema>;
