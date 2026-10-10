import type { Hotspot, TourSettings } from '@internal/contracts';
import type { Tour } from '@panote/viewer/ui';
import { useMemo, useRef, useState, type ReactNode } from 'react';

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

const NONE: never[] = [];

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
  // `target` is the scene asked for; `shown` is the one on screen, which only
  // moves once the viewer reports the new pano drawable. The chrome follows
  // `shown`, so nothing for the next scene lands over the old pano.
  const [target, setTarget] = useState<Scene>(() => ({
    id: start,
    view: data.tour?.scenes[start]?.initialView,
  }));
  const [shown, setShown] = useState(start);
  const [active, setActive] = useState<ViewerHotspot | null>(null);
  const [autoRotate, setAutoRotate] = useState(data.settings.autoRotate);
  // The scene last passed to `onSceneChange`: a reload of the scene on screen
  // (after a failed change) lands it again, and that is not a new visit.
  const reported = useRef<string | null>(null);

  const panoId = shown;
  const moving = target.id !== shown;
  const sceneHotspots = useMemo(
    () => (data.hotspots[panoId] ?? []).map(toHotspot),
    [data.hotspots, panoId],
  );
  const sceneLinks = useMemo<ViewerLinkArrow[]>(
    () =>
      single
        ? []
        : (data.links[panoId] ?? []).map((l) => ({
            to: l.to,
            yaw: l.yaw,
            label: l.label ?? data.titles[l.to] ?? '',
          })),
    [single, data.links, data.titles, panoId],
  );
  // Like the vanilla nav arrows: no points or chevrons while the pano is changing.
  const hotspots = moving ? NONE : sceneHotspots;
  const links = moving ? NONE : sceneLinks;
  const go = (id: string, view: Scene['view']) => {
    setActive(null);
    setTarget({ id, view });
  };
  const landed = (id: string) => {
    setShown(id);
    if (reported.current === id) return;
    reported.current = id;
    onSceneChange?.(id);
  };
  const loadFailed = (error: unknown, id: string) => {
    // A failed change leaves the old pano on screen: go back to it, which
    // also lets the visitor try the same link again.
    if (id === target.id && id !== shown) setTarget({ id: shown, view: undefined });
    onLoadError?.(error, id);
  };
  const scenes = useMemo(
    () =>
      Object.keys(data.tour?.scenes ?? {}).map((id) => ({
        id,
        title: data.titles[id] ?? id,
        ...data.mapPositions[id],
      })),
    [data.tour, data.titles, data.mapPositions],
  );
  const { controls, showCompass, showMap } = data.settings;

  return (
    <div ref={frame} className={cx('pn-tour', className)}>
      <PanoStage
        baseUrl={baseUrl}
        panoId={target.id}
        {...(target.view && { view: target.view })}
        north={data.north[panoId] ?? 0}
        autoRotate={autoRotate}
        transition
        {...(createViewer && { createViewer })}
        aria-label={`${title}: ${data.titles[panoId] ?? ''}`}
        onSceneChange={landed}
        {...(onHotspotOpen && {
          onHotspotOpen: (hotspotId: string) => onHotspotOpen(panoId, hotspotId),
        })}
        onLoadError={loadFailed}
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
