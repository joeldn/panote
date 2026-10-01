import type {
  Hotspot,
  SceneConfig,
  TourDoc,
  TourSettings,
  TourWithConfigsOk,
  View,
} from '@internal/contracts';
import { DEFAULT_TOUR_SETTINGS } from '@internal/contracts';

// Editor state: every document keeps the version it was loaded (or last saved) as,
// the edited version, and the ETag that Save sends as If-Match.

export const UNTITLED_PANO = 'Untitled pano';
const TWO_PI = Math.PI * 2;
// A link's floor chevron sits below the horizon; the viewer only uses its yaw.
export const LINK_PITCH = -0.4;

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

export function fromServer(res: TourWithConfigsOk): EditorDocs {
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
    tour: { etag: res.etag, base: res.tour, current: res.tour },
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

export const findLink = (config: SceneConfig, to: string): Hotspot | undefined =>
  config.hotspots.find((h) => h.type === 'link' && h.targetPanoId === to);

export type EditorAction =
  | { type: 'load'; docs: EditorDocs }
  | { type: 'tour/title'; title: string }
  | { type: 'tour/settings'; settings: Partial<TourSettings> }
  | { type: 'tour/start'; panoId: string }
  | { type: 'tour/remove-scene'; panoId: string }
  | { type: 'scene/title'; panoId: string; title: string }
  | { type: 'scene/start-view'; panoId: string; view: View }
  | { type: 'scene/north'; panoId: string; north: number }
  | { type: 'point/add'; panoId: string; hotspot: Hotspot }
  | { type: 'point/update'; panoId: string; id: string; patch: HotspotPatch }
  | { type: 'point/remove'; panoId: string; id: string }
  | { type: 'link/set'; from: string; to: string; yaw: number; title: string }
  | { type: 'link/nudge'; from: string; to: string; delta: number }
  | { type: 'link/remove'; from: string; to: string }
  | { type: 'saved'; tour?: { etag: string; sent: TourDoc }; configs: SavedConfigs }
  | { type: 'etag'; key: DocKey; etag: string | null }
  | { type: 'replace-doc'; key: DocKey; doc: TourState | SceneState };

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
    case 'tour/title':
      return withTour(docs, (t) => ({ ...t, title: action.title }));
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
    case 'scene/title':
      return withConfig(docs, action.panoId, (c) => ({ ...c, title: action.title }));
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
    case 'point/remove':
      return withConfig(docs, action.panoId, (c) =>
        setHotspots(
          c,
          c.hotspots.filter((h) => h.id !== action.id),
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
