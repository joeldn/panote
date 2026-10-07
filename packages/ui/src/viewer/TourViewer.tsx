import type { Hotspot, TourSettings } from '@internal/contracts';
import type { Tour } from '@panote/viewer/ui';
import { useRef, useState, type ReactNode } from 'react';

import { cx } from '../cx.js';
import { PanoStage, type ViewerFactory } from '../PanoStage.js';
import { usePanoViewer } from '../viewer-context.js';
import { Compass } from './Compass.js';
import { FloorLinks } from './FloorLinks.js';
import { HotspotMarkers } from './HotspotMarkers.js';
import { HotspotPanel } from './HotspotPanel.js';
import { SceneMap } from './SceneMap.js';
import type { ViewerHotspot, ViewerLinkArrow } from './types.js';
import { ViewerControls } from './ViewerControls.js';

/**
 * A tour ready for the viewer. Structurally the part of web-kit's `ViewerTour`
 * the chrome reads, so `toViewerTour(...)` output can be passed as is.
 */
export interface TourViewerData {
  tour: Tour | null;
  hotspots: Record<string, Array<{ source: Hotspot }>>;
  links: Record<string, Array<{ to: string; yaw: number; label?: string }>>;
  north: Record<string, number>;
  titles: Record<string, string>;
  mapPositions: Record<string, { x: number; y: number }>;
  settings: TourSettings;
}

/** The top bar's slots. Left to right: home, breadcrumb, `extras`, then `end` pushed right. */
export interface TourViewerBar {
  home: ReactNode;
  /** Gets the scene on screen, e.g. for its view count. */
  extras?: (panoId: string) => ReactNode;
  end?: ReactNode;
}

export interface TourViewerProps {
  data: TourViewerData;
  /** The tour's title, for the breadcrumb and the stage label. */
  title: string;
  /** Tiles base, e.g. `tilesBaseUrl(config)`. */
  baseUrl: string;
  /** Scene to open on, with its own initial view. Must be a scene of `data.tour`. */
  start: string;
  /** Pins `start`: no floor links and no map, so there is no way to another scene. */
  single?: boolean;
  /** Inline hotspot media is only shown from URLs this accepts. */
  isAllowedMediaUrl: (url: string) => boolean;
  /** Left out for chrome-free use (the embed). */
  bar?: TourViewerBar;
  /** Extra chrome over the stage; gets the scene on screen. */
  overlay?: (panoId: string) => ReactNode;
  /** Adds a Share button to the controls pill. Fullscreen is left before it runs. */
  onShare?: () => void;
  onSceneChange?: (panoId: string) => void;
  onHotspotOpen?: (panoId: string, hotspotId: string) => void;
  onLoadError?: (error: unknown, panoId: string) => void;
  className?: string;
  /** Rendered after the stage, e.g. a share sheet. */
  children?: ReactNode;
  /** Test seam: builds the viewer. */
  createViewer?: ViewerFactory;
}

type Scene = { id: string; view: { yaw?: number; pitch?: number; fov?: number } | undefined };

const toHotspot = ({ source }: { source: Hotspot }): ViewerHotspot => {
  const h: ViewerHotspot = {
    id: source.id,
    yaw: source.yaw,
    pitch: source.pitch,
    title: source.title,
  };
  if (source.body !== undefined) h.body = source.body;
  if (source.icon !== undefined) h.icon = source.icon;
  if (source.size !== undefined) h.size = source.size;
  if (source.media !== undefined) h.media = source.media;
  return h;
};

interface PointsLayerProps {
  panoId: string;
  isAllowedMediaUrl: (url: string) => boolean;
  hotspots: ViewerHotspot[];
  links: ViewerLinkArrow[];
  active: ViewerHotspot | null;
  setActive: (h: ViewerHotspot | null) => void;
  onGo: (link: ViewerLinkArrow) => void;
}

// Rendered inside PanoStage so it can reach the viewer for hotspot-open events.
function PointsLayer({
  panoId,
  isAllowedMediaUrl,
  hotspots,
  links,
  active,
  setActive,
  onGo,
}: PointsLayerProps) {
  const viewer = usePanoViewer();
  const open = (h: ViewerHotspot) => {
    // Clicking the marker of the point already open (e.g. to close it) isn't another open.
    if (active?.id === h.id) return;
    setActive(h);
    viewer?.reportHotspotOpen(h.id);
  };
  return (
    <>
      <FloorLinks key={`links-${panoId}`} links={links} onGo={onGo} />
      <HotspotMarkers
        key={`points-${panoId}`}
        hotspots={hotspots}
        activeId={active?.id ?? null}
        onOpen={open}
      />
      {active && (
        <HotspotPanel
          hotspot={active}
          onClose={() => setActive(null)}
          isAllowedMediaUrl={isAllowedMediaUrl}
        />
      )}
    </>
  );
}

/**
 * Screen 05's viewer: the pano with its points, floor links, compass, map and
 * controls, under an optional top bar. Honours the tour's settings. It sends
 * nothing anywhere itself; analytics hang off the callbacks.
 */
export function TourViewer({
  data,
  title,
  baseUrl,
  start,
  single = false,
  isAllowedMediaUrl,
  bar,
  overlay,
  onShare,
  onSceneChange,
  onHotspotOpen,
  onLoadError,
  className,
  children,
  createViewer,
}: TourViewerProps) {
  const frame = useRef<HTMLDivElement>(null);
  const [scene, setScene] = useState<Scene>(() => ({
    id: start,
    view: data.tour?.scenes[start]?.initialView,
  }));
  const [active, setActive] = useState<ViewerHotspot | null>(null);
  const [autoRotate, setAutoRotate] = useState(data.settings.autoRotate);

  const panoId = scene.id;
  const hotspots = (data.hotspots[panoId] ?? []).map(toHotspot);
  const links: ViewerLinkArrow[] = single
    ? []
    : (data.links[panoId] ?? []).map((l) => ({
        to: l.to,
        yaw: l.yaw,
        label: l.label ?? data.titles[l.to] ?? '',
      }));
  const go = (id: string, view: Scene['view']) => {
    setActive(null);
    setScene({ id, view });
  };
  const scenes = Object.keys(data.tour?.scenes ?? {}).map((id) => ({
    id,
    title: data.titles[id] ?? id,
    ...data.mapPositions[id],
  }));
  const { controls, showCompass, showMap } = data.settings;

  return (
    <div ref={frame} className={cx('pn-tour', className)}>
      <PanoStage
        baseUrl={baseUrl}
        panoId={panoId}
        {...(scene.view && { view: scene.view })}
        north={data.north[panoId] ?? 0}
        autoRotate={autoRotate}
        transition
        {...(createViewer && { createViewer })}
        aria-label={`${title}: ${data.titles[panoId] ?? ''}`}
        {...(onSceneChange && { onSceneChange })}
        {...(onHotspotOpen && {
          onHotspotOpen: (hotspotId: string) => onHotspotOpen(panoId, hotspotId),
        })}
        {...(onLoadError && { onLoadError })}
      >
        <PointsLayer
          isAllowedMediaUrl={isAllowedMediaUrl}
          panoId={panoId}
          hotspots={hotspots}
          links={links}
          active={active}
          setActive={setActive}
          onGo={(link) => go(link.to, { yaw: link.yaw })}
        />
        {bar && (
          <div className="pn-tourbar">
            {bar.home}
            <nav className="pn-crumbs" aria-label="Tour">
              <span className="pn-crumbs__tour">{title}</span>
              <i className="fa-solid fa-chevron-right pn-crumbs__sep" aria-hidden="true" />
              <span className="pn-crumbs__scene" aria-current="location">
                {data.titles[panoId]}
              </span>
            </nav>
            {bar.extras?.(panoId)}
            {bar.end && <div className="pn-tourbar__end">{bar.end}</div>}
          </div>
        )}
        {overlay?.(panoId)}
        {showCompass && <Compass className="pn-tour__compass" />}
        {showMap && !single && scenes.length > 1 && (
          <SceneMap
            scenes={scenes}
            current={panoId}
            onSelect={(id) => go(id, data.tour?.scenes[id]?.initialView)}
          />
        )}
        <ViewerControls
          fullscreenTarget={frame}
          autoRotate={autoRotate}
          onAutoRotateChange={setAutoRotate}
          position={controls}
        >
          {onShare && (
            <button
              type="button"
              className="pn-controls__btn"
              aria-label="Share"
              aria-haspopup="dialog"
              onClick={() => {
                // A share sheet portals to <body>, which a fullscreen stage would hide.
                if (document.fullscreenElement) void document.exitFullscreen();
                onShare();
              }}
            >
              <i className="fa-solid fa-share-nodes" aria-hidden="true" />
            </button>
          )}
        </ViewerControls>
      </PanoStage>
      {children}
    </div>
  );
}
