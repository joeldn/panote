import type {
  Hotspot,
  SceneConfig,
  TourDoc,
  TourLanguages,
  TourSettings,
  TourWithConfigsOk,
  View,
} from '@internal/contracts';
import { DEFAULT_TOUR_SETTINGS, MAX_TITLE_LENGTH } from '@internal/contracts';

// Editor state: every document keeps the version it was loaded (or last saved) as,
// the edited version, and the ETag that Save sends as If-Match.

export const UNTITLED_PANO = 'Untitled pano';
const TWO_PI = Math.PI * 2;
// A link's floor chevron sits below the horizon; the viewer only uses its yaw.
export const LINK_PITCH = -0.4;
// A point's size, a multiple of the default marker (the slider's and the placing drag's range).
export const POINT_SIZE_MIN = 0.5;
export const POINT_SIZE_MAX = 3;
export const POINT_SIZE_STEP = 0.1;
// How far a duplicate lands from its original (about 6°), so the two don't overlap.
export const DUPLICATE_OFFSET = 0.1;
// Half a size-1 marker in px: dragging this far from the drop spot makes a size-1 point.
// The marker is drawn by packages/ui: `.pn-hotspot` in styles/viewer.css is 34px square,
// scaled by `--pn-hs-scale` (the point's size). Keep this in step with that width.
export const MARKER_RADIUS = 17;

export interface TourState {
  etag: string;
  base: TourDoc;
  current: TourDoc;
}

/** A scene with a config; `etag: null` means none is stored yet (Save creates it with `*`). */
export interface ConfigState {
  kind: 'config';
  etag: string | null;
  base: SceneConfig;
  current: SceneConfig;
}

/** A scene whose config is gone: deleted, or mid-delete (tombstone). */
export interface MissingState {
  kind: 'missing';
  deleting: boolean;
}

export type SceneState = ConfigState | MissingState;

export interface EditorDocs {
  tourId: string;
  tour: TourState;
  scenes: Record<string, SceneState>;
}

export type DocKey = 'tour' | `pano:${string}`;
export const panoKey = (panoId: string): DocKey => `pano:${panoId}`;
export const panoIdOf = (key: DocKey): string | null =>
  key === 'tour' ? null : key.slice('pano:'.length);

/** How the conflict and error banners name a document. */
export const docLabel = (docs: EditorDocs, key: DocKey): string => {
  const id = panoIdOf(key);
  if (id === null) return 'Tour details';
  const s = docs.scenes[id];
  return s?.kind === 'config' ? `Pano “${s.current.title}”` : 'A missing pano';
};

/**
 * A tour doc as the editor holds it: a blank description is no description, the same
 * rule the description edit applies. Without this a doc stored with `description: ""`
 * (possible through the raw API) would turn dirty the moment the field was touched,
 * even when it ends up blank again.
 */
export function normalizeTour(tour: TourDoc): TourDoc {
  if (tour.description === undefined || tour.description.trim()) return tour;
  const { description: _blank, ...rest } = tour;
  return rest;
}

export function fromServer(res: TourWithConfigsOk): EditorDocs {
  const tour = normalizeTour(res.tour);
  const scenes: Record<string, SceneState> = {};
  for (const { panoId } of res.tour.scenes) {
    const entry = res.configs[panoId];
    if (entry && 'config' in entry) {
      scenes[panoId] = {
        kind: 'config',
        etag: entry.etag,
        base: entry.config,
        current: entry.config,
      };
    } else if (entry && entry.hasOriginal && !entry.deleting) {
      // Uploaded but never titled (plan 3.1): editable, and the first Save creates it.
      const blank: SceneConfig = { panoId, title: UNTITLED_PANO, hotspots: [] };
      scenes[panoId] = { kind: 'config', etag: null, base: blank, current: blank };
    } else {
      scenes[panoId] = { kind: 'missing', deleting: entry?.deleting ?? false };
    }
  }
  return {
    tourId: res.tour.tourId,
    tour: { etag: res.etag, base: tour, current: tour },
    scenes,
  };
}

/** Structural equality that ignores key order and `undefined`-valued keys. */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => sameValue(v, b[i]));
  }
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(ra), ...Object.keys(rb)]);
  for (const k of keys) if (!sameValue(ra[k], rb[k])) return false;
  return true;
}

export const isTourDirty = (docs: EditorDocs): boolean =>
  !sameValue(docs.tour.base, docs.tour.current);

export const isSceneDirty = (s: SceneState | undefined): s is ConfigState =>
  !!s && s.kind === 'config' && !sameValue(s.base, s.current);

export function dirtyKeys(docs: EditorDocs): DocKey[] {
  const keys: DocKey[] = [];
  for (const [panoId, s] of Object.entries(docs.scenes)) {
    if (isSceneDirty(s)) keys.push(panoKey(panoId));
  }
  if (isTourDirty(docs)) keys.push('tour');
  return keys;
}

/**
 * Folds in a server tour that differs from `local.base` only by scenes appended to it
 * (the upload chip adding a pano): the server copy becomes the base, with its ETag, and
 * local edits stay on top. Null when the server tour changed in any other way.
 */
export function mergeAppendedScenes(
  local: TourState,
  server: { etag: string; tour: TourDoc },
): TourState | null {
  const known = new Set(local.base.scenes.map((s) => s.panoId));
  const added = server.tour.scenes.filter((s) => !known.has(s.panoId));
  const rest = { ...server.tour, scenes: server.tour.scenes.filter((s) => known.has(s.panoId)) };
  if (!sameValue(rest, local.base)) return null;
  const inCurrent = new Set(local.current.scenes.map((s) => s.panoId));
  return {
    etag: server.etag,
    base: server.tour,
    current: {
      ...local.current,
      scenes: [...local.current.scenes, ...added.filter((s) => !inCurrent.has(s.panoId))],
    },
  };
}

/** Wrap into (-π, π], the same canonical form the contract stores. */
export function normalizeAngle(a: number): number {
  const wrapped = a % TWO_PI;
  if (wrapped > Math.PI) return wrapped - TWO_PI;
  if (wrapped <= -Math.PI) return wrapped + TWO_PI;
  return wrapped;
}

/** Yaw as a 0..359 compass-style degree label. */
export const yawDegrees = (yaw: number): number =>
  ((Math.round((yaw * 180) / Math.PI) % 360) + 360) % 360;

/**
 * The size a drag of `distance` px from the drop spot sets: the marker's radius follows
 * the pointer, in slider steps. `null` is the default size, which isn't stored. A drag
 * that stays inside a default marker is a wobbly click or tap, not a request for a
 * small point, so it leaves the size alone: the slider goes below 1×.
 */
export function pointSizeForDrag(distance: number): number | null {
  if (distance < MARKER_RADIUS) return null;
  const raw = Math.round(distance / MARKER_RADIUS / POINT_SIZE_STEP) * POINT_SIZE_STEP;
  const size = Math.min(POINT_SIZE_MAX, Math.max(POINT_SIZE_MIN, Number(raw.toFixed(1))));
  return size === 1 ? null : size;
}

const copyTitle = (title: string): string => {
  const suffix = ' (copy)';
  return title.slice(0, MAX_TITLE_LENGTH - suffix.length) + suffix;
};

export const findLink = (config: SceneConfig, to: string): Hotspot | undefined =>
  config.hotspots.find((h) => h.type === 'link' && h.targetPanoId === to);

/**
 * One field's translation set (`value`) or cleared (`null`, or blank): an emptied entry
 * goes, and so does an emptied map, so a translation that is removed again is no edit.
 */
export function setTranslation<F extends string>(
  i18n: Partial<Record<string, Partial<Record<F, string | undefined>> | undefined>> | undefined,
  lang: string,
  field: F,
  value: string | null,
): Record<string, Partial<Record<F, string>>> | undefined {
  const out: Record<string, Partial<Record<F, string>>> = {};
  for (const [k, v] of Object.entries(i18n ?? {})) if (v) out[k] = v as Partial<Record<F, string>>;
  const entry: Partial<Record<F, string>> = { ...out[lang] };
  if (value) entry[field] = value;
  else delete entry[field];
  if (Object.keys(entry).length > 0) out[lang] = entry;
  else delete out[lang];
  return Object.keys(out).length > 0 ? out : undefined;
}

/** `doc` with its `i18n` replaced; an undefined map drops the key. */
function withI18n<T extends { i18n?: unknown }>(doc: T, i18n: T['i18n'] | undefined): T {
  const { i18n: _old, ...rest } = doc;
  return (i18n === undefined ? rest : { ...rest, i18n }) as T;
}

/** `doc` without `lang`'s translations. */
function dropLanguage<T extends { i18n?: Partial<Record<string, unknown>> | undefined }>(
  doc: T,
  lang: string,
): T {
  if (!doc.i18n || !(lang in doc.i18n)) return doc;
  const { [lang]: _gone, ...rest } = doc.i18n;
  return withI18n(doc, (Object.keys(rest).length > 0 ? rest : undefined) as T['i18n']);
}

export type TranslationPatch = Partial<{ title: string | null; body: string | null }>;

export type EditorAction =
  | { type: 'load'; docs: EditorDocs }
  /** With `lang`, the title's translation into it (blank clears it). */
  | { type: 'tour/title'; title: string; lang?: string }
  | { type: 'tour/description'; description: string; lang?: string }
  | { type: 'tour/languages'; languages: TourLanguages }
  /** Drops a translation language and the tour's own strings in it (pano strings stay). */
  | { type: 'lang/remove'; lang: string }
  | { type: 'tour/settings'; settings: Partial<TourSettings> }
  | { type: 'tour/start'; panoId: string }
  | { type: 'tour/remove-scene'; panoId: string }
  | { type: 'scene/title'; panoId: string; title: string; lang?: string }
  | { type: 'scene/start-view'; panoId: string; view: View }
  | { type: 'scene/north'; panoId: string; north: number }
  | { type: 'point/add'; panoId: string; hotspot: Hotspot }
  | { type: 'point/update'; panoId: string; id: string; patch: HotspotPatch }
  | { type: 'point/translate'; panoId: string; id: string; lang: string; patch: TranslationPatch }
  | { type: 'point/remove'; panoId: string; id: string }
  | { type: 'point/duplicate'; panoId: string; id: string; newId: string }
  | { type: 'link/set'; from: string; to: string; yaw: number; title: string }
  | { type: 'link/nudge'; from: string; to: string; delta: number }
  | { type: 'link/remove'; from: string; to: string }
  | { type: 'saved'; tour?: { etag: string; sent: TourDoc }; configs: SavedConfigs }
  | { type: 'etag'; key: DocKey; etag: string | null }
  | { type: 'replace-doc'; key: DocKey; doc: TourState | SceneState }
  | { type: 'add-scenes'; scenes: Record<string, SceneState> };

export type SavedConfigs = Record<string, { etag: string; sent: SceneConfig }>;

/** Fields an info point editor may change; `null` clears an optional field. */
export type HotspotPatch = Partial<{
  title: string;
  body: string | null;
  icon: string | null;
  size: number | null;
  media: Hotspot['media'] | null;
  yaw: number;
  pitch: number;
}>;

function patchHotspot(h: Hotspot, patch: HotspotPatch): Hotspot {
  const next: Record<string, unknown> = { ...h };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === undefined) delete next[k];
    else next[k] = k === 'yaw' ? normalizeAngle(v as number) : v;
  }
  return next as Hotspot;
}

function withTour(docs: EditorDocs, fn: (t: TourDoc) => TourDoc): EditorDocs {
  return { ...docs, tour: { ...docs.tour, current: fn(docs.tour.current) } };
}

function withConfig(
  docs: EditorDocs,
  panoId: string,
  fn: (c: SceneConfig) => SceneConfig,
): EditorDocs {
  const s = docs.scenes[panoId];
  if (!s || s.kind !== 'config') return docs;
  return { ...docs, scenes: { ...docs.scenes, [panoId]: { ...s, current: fn(s.current) } } };
}

const setHotspots = (c: SceneConfig, hotspots: Hotspot[]): SceneConfig => ({ ...c, hotspots });

export function editorReducer(docs: EditorDocs | null, action: EditorAction): EditorDocs | null {
  if (action.type === 'load') return action.docs;
  if (!docs) return docs;
  switch (action.type) {
    case 'tour/title': {
      const { lang } = action;
      if (lang) {
        return withTour(docs, (t) =>
          withI18n(t, setTranslation(t.i18n, lang, 'title', action.title.trim() || null)),
        );
      }
      return withTour(docs, (t) => ({ ...t, title: action.title }));
    }
    case 'tour/description': {
      const { lang } = action;
      if (lang) {
        return withTour(docs, (t) =>
          withI18n(
            t,
            setTranslation(t.i18n, lang, 'description', action.description.trim() || null),
          ),
        );
      }
      // Stored trimmed, like the server does; blank means no description.
      return withTour(docs, (t) => {
        const { description: _old, ...rest } = t;
        const description = action.description.trim();
        return description ? { ...rest, description } : rest;
      });
    }
    case 'tour/languages':
      return withTour(docs, (t) => ({ ...t, languages: action.languages }));
    case 'lang/remove': {
      // Only the tour's own strings. A pano's translations stay with its config: the pano
      // may be in other tours that still have the language, and publish only ever sends
      // a tour's own languages, so the removed one stops showing here either way.
      const { lang } = action;
      return withTour(docs, (t) => {
        const cleared = dropLanguage(t, lang);
        if (!t.languages) return cleared;
        const others = t.languages.others.filter((l) => l !== lang);
        return { ...cleared, languages: { ...t.languages, others } };
      });
    }
    case 'tour/settings':
      return withTour(docs, (t) => ({
        ...t,
        settings: { ...(t.settings ?? DEFAULT_TOUR_SETTINGS), ...action.settings },
      }));
    case 'tour/start':
      return withTour(docs, (t) => ({ ...t, startPanoId: action.panoId }));
    case 'tour/remove-scene':
      // The pano and its config stay; it just leaves this tour (screen 13 copy).
      return withTour(docs, (t) => {
        const { startPanoId, ...rest } = t;
        const scenes = t.scenes.filter((s) => s.panoId !== action.panoId);
        return startPanoId === undefined || startPanoId === action.panoId
          ? { ...rest, scenes }
          : { ...rest, scenes, startPanoId };
      });
    case 'scene/title': {
      const { lang } = action;
      if (lang) {
        return withConfig(docs, action.panoId, (c) =>
          withI18n(c, setTranslation(c.i18n, lang, 'title', action.title.trim() || null)),
        );
      }
      return withConfig(docs, action.panoId, (c) => ({ ...c, title: action.title }));
    }
    case 'scene/start-view':
      return withConfig(docs, action.panoId, (c) => ({
        ...c,
        initialView: { ...action.view, yaw: normalizeAngle(action.view.yaw) },
      }));
    case 'scene/north':
      return withConfig(docs, action.panoId, (c) => ({
        ...c,
        north: normalizeAngle(action.north),
      }));
    case 'point/add':
      return withConfig(docs, action.panoId, (c) =>
        setHotspots(c, [
          ...c.hotspots,
          { ...action.hotspot, yaw: normalizeAngle(action.hotspot.yaw) },
        ]),
      );
    case 'point/update':
      return withConfig(docs, action.panoId, (c) =>
        setHotspots(
          c,
          c.hotspots.map((h) => (h.id === action.id ? patchHotspot(h, action.patch) : h)),
        ),
      );
    case 'point/translate': {
      const { lang, patch } = action;
      return withConfig(docs, action.panoId, (c) =>
        setHotspots(
          c,
          c.hotspots.map((h) => {
            if (h.id !== action.id) return h;
            let i18n = h.i18n;
            for (const field of ['title', 'body'] as const) {
              const v = patch[field];
              if (v !== undefined) i18n = setTranslation(i18n, lang, field, v?.trim() ? v : null);
            }
            return withI18n(h, i18n);
          }),
        ),
      );
    }
    case 'point/remove':
      return withConfig(docs, action.panoId, (c) =>
        setHotspots(
          c,
          c.hotspots.filter((h) => h.id !== action.id),
        ),
      );
    case 'point/duplicate':
      // Right after the original in the list, nudged round so both markers can be seen.
      return withConfig(docs, action.panoId, (c) =>
        setHotspots(
          c,
          c.hotspots.flatMap((h) =>
            h.id === action.id
              ? [
                  h,
                  {
                    ...h,
                    id: action.newId,
                    title: copyTitle(h.title),
                    yaw: normalizeAngle(h.yaw + DUPLICATE_OFFSET),
                  },
                ]
              : [h],
          ),
        ),
      );
    case 'link/set':
      return withConfig(docs, action.from, (c) => {
        const yaw = normalizeAngle(action.yaw);
        const existing = findLink(c, action.to);
        if (existing) {
          return setHotspots(
            c,
            c.hotspots.map((h) => (h === existing ? { ...h, yaw } : h)),
          );
        }
        const link: Hotspot = {
          id: newId('link'),
          type: 'link',
          yaw,
          pitch: LINK_PITCH,
          title: action.title,
          targetPanoId: action.to,
        };
        return setHotspots(c, [...c.hotspots, link]);
      });
    case 'link/nudge':
      return withConfig(docs, action.from, (c) => {
        const link = findLink(c, action.to);
        if (!link) return c;
        const yaw = normalizeAngle(link.yaw + action.delta);
        return setHotspots(
          c,
          c.hotspots.map((h) => (h === link ? { ...h, yaw } : h)),
        );
      });
    case 'link/remove':
      return withConfig(docs, action.from, (c) =>
        setHotspots(
          c,
          c.hotspots.filter((h) => !(h.type === 'link' && h.targetPanoId === action.to)),
        ),
      );
    case 'saved': {
      // Base becomes what was sent, not the live state: edits made during the save stay dirty.
      const scenes = { ...docs.scenes };
      for (const [panoId, { etag, sent }] of Object.entries(action.configs)) {
        const s = scenes[panoId];
        if (s?.kind === 'config') scenes[panoId] = { ...s, etag, base: sent };
      }
      const tour = action.tour
        ? { ...docs.tour, etag: action.tour.etag, base: action.tour.sent }
        : docs.tour;
      return { ...docs, tour, scenes };
    }
    case 'etag': {
      if (action.key === 'tour') {
        return action.etag === null ? docs : { ...docs, tour: { ...docs.tour, etag: action.etag } };
      }
      const panoId = panoIdOf(action.key)!;
      const s = docs.scenes[panoId];
      if (s?.kind !== 'config') return docs;
      return { ...docs, scenes: { ...docs.scenes, [panoId]: { ...s, etag: action.etag } } };
    }
    case 'add-scenes': {
      // Only scenes this editor doesn't know yet; local (possibly dirty) configs stay.
      const scenes = { ...docs.scenes };
      for (const [panoId, scene] of Object.entries(action.scenes)) scenes[panoId] ??= scene;
      return { ...docs, scenes };
    }
    case 'replace-doc': {
      if (action.key === 'tour') return { ...docs, tour: action.doc as TourState };
      const panoId = panoIdOf(action.key)!;
      return { ...docs, scenes: { ...docs.scenes, [panoId]: action.doc as SceneState } };
    }
  }
}

export function newId(prefix: string): string {
  const raw =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2);
  return `${prefix}-${raw.replace(/-/g, '').slice(0, 12)}`;
}
