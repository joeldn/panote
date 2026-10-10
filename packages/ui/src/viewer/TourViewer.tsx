import type { Hotspot, TourSettings } from '@internal/contracts';
import type { PanoViewer } from '@panote/viewer';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { cx } from '../cx.js';
import { prefetchPano } from '../panote-viewer.js';
import { PanoStage, type ViewerFactory } from '../PanoStage.js';
import { useStageEvents } from '../stage-events.js';
import { usePanoViewer } from '../viewer-context.js';
import { Compass } from './Compass.js';
import { FloorLinks } from './FloorLinks.js';
import { HotspotMarkers } from './HotspotMarkers.js';
import { HotspotPanel } from './HotspotPanel.js';
import { SceneMap } from './SceneMap.js';
import type { ViewerHotspot, ViewerLinkArrow, ViewerTourGraph } from './types.js';
import { ViewerControls } from './ViewerControls.js';

/**
 * A tour ready for the viewer. Structurally the part of web-kit's `ViewerTour`
 * the chrome reads, so `toViewerTour(...)` output can be passed as is.
 */
export interface TourViewerData {
  tour: ViewerTourGraph | null;
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
  /** Test seam: warms the cache for a linked scene (defaults to `prefetchPano`). */
  prefetch?: typeof prefetchPano;
}

type Scene = { id: string; view: { yaw?: number; pitch?: number; fov?: number } | undefined };

const NONE: never[] = [];

// Auto-rotate is motion the visitor didn't start, so it starts off for those who opt out.
const prefersReducedMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

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

// Rendered inside PanoStage so it can report point opens through the stage.
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
  const events = useStageEvents();
  const open = (h: ViewerHotspot) => {
    // The marker is a toggle (aria-pressed): a second click closes its point.
    if (active?.id === h.id) {
      setActive(null);
      return;
    }
    setActive(h);
    // Reported once the stage has its viewer, as when the open went through
    // the viewer: a click before that is not counted.
    if (viewer) events.hotspotOpen(h.id);
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

// Linked scenes warmed per scene: each costs a manifest and six base tiles.
const PREFETCH_LIMIT = 3;

interface LinkPrefetchProps {
  /** Scenes to warm, in order; empty while a change is in flight. */
  targets: readonly string[];
  prefetch: typeof prefetchPano;
}

// Once the scene on screen has its tiles, warm the next scenes' bases so a
// floor-link hop starts from the cache. Rendered inside PanoStage for the viewer.
function LinkPrefetch({ targets, prefetch }: LinkPrefetchProps) {
  const viewer = usePanoViewer();
  const key = targets.join('\n');
  const latest = useRef({ targets, prefetch });
  useEffect(() => {
    latest.current = { targets, prefetch };
  });
  useEffect(() => {
    if (!viewer || key === '') return;
    const controller = new AbortController();
    const settled = () => {
      // Once per scene: later settles follow pans, not a new scene.
      viewer.off('tiles-settled', settled);
      const { targets: ids, prefetch: warm } = latest.current;
      for (const id of ids) void warm(viewer, id, { signal: controller.signal });
    };
    viewer.on('tiles-settled', settled);
    // This effect runs after the scene swapped in, and a scene that needs no
    // more than its base can settle before that: its event has gone.
    if (viewer.isSettled()) settled();
    return () => {
      viewer.off('tiles-settled', settled);
      // Deliberately all of them, even one for the scene being entered: the
      // real load fetches the same URLs at full priority, and the next
      // scene's own prefetch should not queue behind this one's.
      controller.abort();
    };
  }, [viewer, key]);
  return null;
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
  prefetch = prefetchPano,
}: TourViewerProps) {
  const frame = useRef<HTMLDivElement>(null);
  const [viewer, setViewer] = useState<PanoViewer | null>(null);
  // `target` is the scene asked for; `shown` is the one on screen, which only
  // moves once the viewer reports the new pano drawable. The chrome follows
  // `shown`, so nothing for the next scene lands over the old pano.
  const [target, setTarget] = useState<Scene>(() => ({
    id: start,
    view: data.tour?.scenes[start]?.initialView,
  }));
  const [shown, setShown] = useState(start);
  // The viewer (and its baseUrl) that last reported a scene on screen. Until
  // the current viewer has, it is empty and counts as settled, so the
  // prefetch would race its first load. The baseUrl is checked too: in the
  // render where it changes, the old viewer is still the one in hand.
  const [arrivedOn, setArrivedOn] = useState<{ viewer: PanoViewer; baseUrl: string } | null>(null);
  const arrived = arrivedOn?.viewer === viewer && arrivedOn.baseUrl === baseUrl;
  const [active, setActive] = useState<ViewerHotspot | null>(null);
  const [autoRotate, setAutoRotate] = useState(
    () => data.settings.autoRotate && !prefersReducedMotion(),
  );
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
  const prefetchTargets = useMemo(
    () =>
      arrived
        ? [...new Set(links.map((l) => l.to))]
            .filter((id) => id !== panoId)
            .slice(0, PREFETCH_LIMIT)
        : NONE,
    [arrived, links, panoId],
  );
  const go = (id: string, view: Scene['view']) => {
    // Markers and chevrons hide during a move, so one activated from the
    // keyboard would take focus down to <body> with it: hand focus to the
    // viewer before it goes.
    const focused = document.activeElement;
    const root = frame.current;
    if (viewer && root && focused?.closest('.pn-anchors') && root.contains(focused)) {
      viewer.focus();
    }
    setActive(null);
    setTarget({ id, view });
  };
  const landed = (id: string) => {
    setShown(id);
    if (viewer) setArrivedOn({ viewer, baseUrl });
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
        onViewer={setViewer}
        onSceneChange={landed}
        {...(onHotspotOpen && {
          onHotspotOpen: (hotspotId: string) => onHotspotOpen(panoId, hotspotId),
        })}
        onLoadError={loadFailed}
      >
        <LinkPrefetch targets={prefetchTargets} prefetch={prefetch} />
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
            {...(moving && { pending: target.id })}
            // Back to the scene on screen cancels a change and keeps the camera.
            onSelect={(id) =>
              go(id, id === panoId ? undefined : data.tour?.scenes[id]?.initialView)
            }
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
                // It can be refused (e.g. an embed without allow="fullscreen").
                if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
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
