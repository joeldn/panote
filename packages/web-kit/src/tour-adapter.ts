import type { SceneConfig, TourConfigEntry, TourDoc, TourSettings } from '@internal/contracts';
import type { InfoHotspotData, Tour, TourLink, TourScene } from '@panote/viewer/ui';

/** Prototype defaults (design `tourCfg`), used when a tour has no saved settings. */
export const DEFAULT_TOUR_SETTINGS: TourSettings = {
  controls: 'bottom',
  showMap: true,
  showCompass: true,
  autoRotate: false,
};

export interface ViewerTour {
  /** Null when no scene of the tour has a loadable config. */
  tour: Tour | null;
  /** Info hotspots per panoId, ready for `mountInfoHotspots`. */
  hotspots: Record<string, InfoHotspotData[]>;
  /** Compass north offset per panoId, radians (0 when unset). */
  north: Record<string, number>;
  titles: Record<string, string>;
  /** Floor-plan positions for the mini-map, where the tour has them. */
  mapPositions: Record<string, { x: number; y: number }>;
  /** Scenes listed by the tour whose config is missing; left out of `tour`. */
  missing: string[];
  settings: TourSettings;
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
 */
export function toViewerTour(doc: TourDoc, configs: SceneConfigSource): ViewerTour {
  const loaded = new Map<string, SceneConfig>();
  const missing: string[] = [];
  const mapPositions: ViewerTour['mapPositions'] = {};
  for (const scene of doc.scenes) {
    if (loaded.has(scene.panoId) || missing.includes(scene.panoId)) continue;
    const config = configOf(configs[scene.panoId]);
    // A config saved under another panoId is not this scene's config.
    if (config && config.panoId === scene.panoId) {
      loaded.set(scene.panoId, config);
      if (scene.mapX !== undefined && scene.mapY !== undefined) {
        mapPositions[scene.panoId] = { x: scene.mapX, y: scene.mapY };
      }
    } else {
      missing.push(scene.panoId);
    }
  }

  const scenes: Record<string, TourScene> = {};
  const hotspots: ViewerTour['hotspots'] = {};
  const north: ViewerTour['north'] = {};
  const titles: ViewerTour['titles'] = {};
  for (const [panoId, config] of loaded) {
    const links: TourLink[] = [];
    const info: InfoHotspotData[] = [];
    for (const h of config.hotspots) {
      if (h.type === 'link') {
        const target = h.targetPanoId !== undefined ? loaded.get(h.targetPanoId) : undefined;
        if (target && h.targetPanoId !== panoId) {
          links.push({ to: target.panoId, yaw: h.yaw, label: target.title });
        }
        continue;
      }
      const data: InfoHotspotData = { id: h.id, yaw: h.yaw, pitch: h.pitch, title: h.title };
      if (h.body !== undefined) data.body = h.body;
      info.push(data);
    }
    const scene: TourScene = { links };
    if (config.initialView) scene.initialView = { ...config.initialView };
    scenes[panoId] = scene;
    hotspots[panoId] = info;
    north[panoId] = config.north ?? 0;
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
    north,
    titles,
    mapPositions,
    missing,
    settings: doc.settings ?? DEFAULT_TOUR_SETTINGS,
  };
}
