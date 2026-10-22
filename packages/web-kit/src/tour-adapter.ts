import {
  localizeConfigs,
  localizePublishedTour,
  planKey,
  type Hotspot,
  type PublishedTour,
  type SceneConfig,
  type TourConfigEntry,
  type TourDoc,
  type TourSettings,
} from '@internal/contracts';
import type { InfoHotspotData, Tour, TourLink, TourScene } from './tour-types.js';

/** Prototype defaults (design `tourCfg`), used when a tour has no saved settings. */
export const DEFAULT_TOUR_SETTINGS: TourSettings = {
  controls: 'bottom',
  showMap: true,
  showCompass: true,
  autoRotate: false,
};

/** Viewer info-hotspot data plus the stored hotspot (icon, size, media) it came from. */
export type ViewerInfoHotspot = InfoHotspotData & { source: Hotspot };
/** Viewer link plus its stored link hotspot. */
export type ViewerLink = TourLink & { source: Hotspot };

export interface ViewerTour {
  /** Null when no scene of the tour has a loadable config. */
  tour: Tour | null;
  /** Info hotspots per panoId, ready for `mountInfoHotspots`. */
  hotspots: Record<string, ViewerInfoHotspot[]>;
  /** The same objects as `tour.scenes[id].links`, typed with their `source`. */
  links: Record<string, ViewerLink[]>;
  /** Compass north offset per panoId, radians (0 when unset). */
  north: Record<string, number>;
  titles: Record<string, string>;
  /** Floor-plan positions for the mini-map, where the tour has them (contracts plan.ts). */
  mapPositions: Record<string, { x: number; y: number }>;
  /** The scenes whose north has been set, so the mini-map can show which way the view faces. */
  hasNorth: Record<string, boolean>;
  /** The floor-plan image behind the mini-map; null without one (or without `cdnBase`). */
  plan: ViewerPlan | null;
  /** Scenes listed by the tour whose config is missing; left out of `tour`. */
  missing: string[];
  settings: TourSettings;
}

/** A tour's floor-plan image, ready for an `<img>`. */
export interface ViewerPlan {
  url: string;
  width: number;
  height: number;
}

export interface ViewerTourOptions {
  /** CDN root with a trailing slash (`AppConfig.cdnBase`), for the plan image's URL. */
  cdnBase?: string;
}

export type SceneConfigSource = Record<string, SceneConfig | TourConfigEntry | null | undefined>;

const configOf = (entry: SceneConfig | TourConfigEntry | null | undefined): SceneConfig | null => {
  if (!entry) return null;
  if ('missing' in entry) return null;
  if ('config' in entry) return entry.config;
  return entry;
};

/**
 * Adapt a stored tour (link hotspots with `targetPanoId`) to the viewer's
 * `Tour` (scenes with `links`). Inputs are schema-parsed, so angles are canonical.
 * `lang` picks the scenes' and points' text (see pickLanguage); untranslated text
 * stays in the default language.
 */
export function toViewerTour(
  doc: TourDoc,
  configs: SceneConfigSource,
  lang?: string | null,
  options: ViewerTourOptions = {},
): ViewerTour {
  const stored = new Map<string, SceneConfig>();
  const missing: string[] = [];
  const mapPositions: ViewerTour['mapPositions'] = {};
  for (const scene of doc.scenes) {
    if (stored.has(scene.panoId) || missing.includes(scene.panoId)) continue;
    const config = configOf(configs[scene.panoId]);
    // A config saved under another panoId is not this scene's config.
    if (config && config.panoId === scene.panoId) {
      stored.set(scene.panoId, config);
      if (scene.mapX !== undefined && scene.mapY !== undefined) {
        mapPositions[scene.panoId] = { x: scene.mapX, y: scene.mapY };
      }
    } else {
      missing.push(scene.panoId);
    }
  }
  const loaded = lang ? localizeConfigs(stored, lang) : stored;

  const scenes: Record<string, TourScene> = {};
  const hotspots: ViewerTour['hotspots'] = {};
  const linksByPano: ViewerTour['links'] = {};
  const north: ViewerTour['north'] = {};
  const hasNorth: ViewerTour['hasNorth'] = {};
  const titles: ViewerTour['titles'] = {};
  for (const [panoId, config] of loaded) {
    const links: ViewerLink[] = [];
    const info: ViewerInfoHotspot[] = [];
    for (const h of config.hotspots) {
      if (h.type === 'link') {
        const target = h.targetPanoId !== undefined ? loaded.get(h.targetPanoId) : undefined;
        if (target && h.targetPanoId !== panoId) {
          // The hotspot's own title labels the arrow; the target scene's is the fallback.
          links.push({ to: target.panoId, yaw: h.yaw, label: h.title || target.title, source: h });
        }
        continue;
      }
      const data: ViewerInfoHotspot = {
        id: h.id,
        yaw: h.yaw,
        pitch: h.pitch,
        title: h.title,
        source: h,
      };
      if (h.body !== undefined) data.body = h.body;
      info.push(data);
    }
    const scene: TourScene = { links };
    if (config.initialView) scene.initialView = { ...config.initialView };
    scenes[panoId] = scene;
    hotspots[panoId] = info;
    linksByPano[panoId] = links;
    north[panoId] = config.north ?? 0;
    hasNorth[panoId] = config.north !== undefined;
    titles[panoId] = config.title;
  }

  const first = loaded.keys().next();
  const start =
    doc.startPanoId !== undefined && loaded.has(doc.startPanoId)
      ? doc.startPanoId
      : first.done
        ? null
        : first.value;

  return {
    tour: start === null ? null : { start, scenes },
    hotspots,
    links: linksByPano,
    north,
    titles,
    mapPositions,
    hasNorth,
    plan:
      doc.plan && options.cdnBase !== undefined
        ? {
            url: `${options.cdnBase}${planKey(doc.tourId, doc.plan.id, doc.plan.type)}`,
            width: doc.plan.width,
            height: doc.plan.height,
          }
        : null,
    missing,
    settings: doc.settings ?? DEFAULT_TOUR_SETTINGS,
  };
}

/**
 * Adapt a published bundle (`pub/tours/<tourId>.json`) the same way as an owner's tour,
 * with its text in `lang`.
 */
export function publishedToViewerTour(
  published: PublishedTour,
  lang?: string | null,
  options: ViewerTourOptions = {},
): ViewerTour {
  const pub = localizePublishedTour(published, lang);
  const doc: TourDoc = {
    tourId: pub.tourId,
    title: pub.title,
    startPanoId: pub.startPanoId,
    settings: pub.settings,
    ...(pub.plan && { plan: pub.plan }),
    scenes: pub.scenes.map(({ panoId, mapX, mapY }) => ({
      panoId,
      ...(mapX !== undefined && { mapX }),
      ...(mapY !== undefined && { mapY }),
    })),
  };
  return toViewerTour(
    doc,
    Object.fromEntries(pub.scenes.map((s) => [s.panoId, s.config])),
    null,
    options,
  );
}
