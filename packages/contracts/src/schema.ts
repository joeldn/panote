import { z } from 'zod';

import { PANO_PATTERN } from './keys.js';
import { LanguageTagSchema, MAX_TOUR_LANGUAGES, TourLanguagesSchema } from './languages.js';

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
const translations = <T extends z.ZodRawShape>(fields: T) =>
  z
    .record(LanguageTagSchema, z.object(fields))
    .refine((r) => Object.keys(r).length <= MAX_TOUR_LANGUAGES - 1, {
      message: `at most ${MAX_TOUR_LANGUAGES - 1} translations`,
    });

/**
 * All translated text in one scene config (its own and its hotspots') is capped
 * together, so translations add a bounded amount to a config and to the pub bundle
 * that embeds it, whatever the number of languages or points.
 */
export const MAX_SCENE_TRANSLATION_CHARS = 200_000;

const translatedChars = (i18n: Record<string, Record<string, string | undefined>> | undefined) =>
  Object.values(i18n ?? {}).reduce(
    (n, entry) => n + Object.values(entry).reduce((m, v) => m + (v?.length ?? 0), 0),
    0,
  );

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
    i18n: translations({
      title: z.string().min(1).max(MAX_TITLE_LENGTH).optional(),
      body: z.string().min(1).max(MAX_HOTSPOT_BODY_LENGTH).optional(),
    }).optional(),
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
    i18n: translations({
      title: z.string().min(1).max(MAX_TITLE_LENGTH).optional(),
      description: z.string().min(1).max(MAX_SCENE_DESCRIPTION_LENGTH).optional(),
    }).optional(),
  })
  .refine(
    (c) =>
      translatedChars(c.i18n) + c.hotspots.reduce((n, h) => n + translatedChars(h.i18n), 0) <=
      MAX_SCENE_TRANSLATION_CHARS,
    { message: `translations exceed ${MAX_SCENE_TRANSLATION_CHARS} characters`, path: ['i18n'] },
  );
export type SceneConfig = z.infer<typeof SceneConfigSchema>;

// Same reason as SceneConfigSchema.panoId above.
export const TourSceneSchema = z.object({
  panoId: z.string().regex(PANO_PATTERN, `panoId must match ${PANO_PATTERN}`).max(MAX_ID_LENGTH),
  mapX: z.number().finite().optional(),
  mapY: z.number().finite().optional(),
});
export type TourScene = z.infer<typeof TourSceneSchema>;

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
  // Optional: a tour without it has one, unnamed language (Q4).
  languages: TourLanguagesSchema.optional(),
  i18n: translations({
    title: z.string().min(1).max(MAX_TITLE_LENGTH).optional(),
    description: TourDescriptionSchema.pipe(z.string().min(1)).optional(),
  }).optional(),
});
export type TourDoc = z.infer<typeof TourDocSchema>;
