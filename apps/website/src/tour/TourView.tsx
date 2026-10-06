import type { PublishedTour, ViewBeacon } from '@internal/contracts';
import {
  Compass,
  FloorLinks,
  HotspotMarkers,
  HotspotPanel,
  Logo,
  LogoMark,
  PanoStage,
  SceneMap,
  ShareModal,
  usePanoViewer,
  ViewerControls,
  type ViewerHotspot,
  type ViewerLinkArrow,
} from '@internal/ui';
import { publishedToViewerTour, tilesBaseUrl, type ViewerTour } from '@internal/web-kit';
import { useContext, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';

import './tour.css';

import { useAuthEnv } from '../auth-context.js';
import { useConfig } from '../config-context.js';
import { useViewerAnalytics } from './analytics.js';
import { StageFactoryContext } from './stage-factory.js';
import { StatsChips } from './StatsChips.js';
import { Unavailable } from './Unavailable.js';
import { useIsOwner } from './use-owner.js';
import { useTourStats } from './use-stats.js';

type Scene = { id: string; view: { yaw?: number; pitch?: number; fov?: number } | undefined };

const toHotspot = ({ source }: ViewerTour['hotspots'][string][number]): ViewerHotspot => {
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

// Inline media must come from the CDN: that is all the CSP's img-src/media-src allow.
const cdnMatcher = (cdnBase: string) => {
  const cdn = new URL(cdnBase).origin;
  return (url: string): boolean => URL.canParse(url) && new URL(url).origin === cdn;
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

// Mounted only once a scene is shown, so an unavailable tour never records a view.
function TourStats({
  tourId,
  visible,
  view,
}: {
  tourId: string;
  visible: boolean;
  view: ViewBeacon;
}) {
  const stats = useTourStats(tourId, view);
  return visible ? <StatsChips {...stats} /> : null;
}

/** "Edit" for the tour's owner only (plan 4.3, row 05); never mounted in the embed. */
function OwnerEdit({ tourId }: { tourId: string }) {
  const { origins } = useAuthEnv();
  const owner = useIsOwner(tourId);
  if (!owner) return null;
  return (
    <a className="tour-edit" href={`${origins.admin}/app/t/${encodeURIComponent(tourId)}`}>
      Edit
    </a>
  );
}

/** Screen 05: the visitor viewer, or the chrome-free embed. */
export function TourView({ tour, embed }: { tour: PublishedTour; embed: boolean }) {
  const config = useConfig();
  const createViewer = useContext(StageFactoryContext);
  const [params] = useSearchParams();
  const vt = useMemo(() => publishedToViewerTour(tour), [tour]);
  const frame = useRef<HTMLDivElement>(null);
  const isCdnUrl = useMemo(() => cdnMatcher(config.cdnBase), [config.cdnBase]);

  const requested = params.get('pano');
  const requestedOk = requested !== null && !!vt.tour?.scenes[requested];
  // Embed ?pano= pins a single scene with no way out (design README:130).
  const single = embed && requested !== null;
  const start = requestedOk ? requested : (vt.tour?.start ?? null);

  const [scene, setScene] = useState<Scene | null>(() =>
    start ? { id: start, view: vt.tour?.scenes[start]?.initialView } : null,
  );
  const [active, setActive] = useState<ViewerHotspot | null>(null);
  const [autoRotate, setAutoRotate] = useState(vt.settings.autoRotate);
  const [failed, setFailed] = useState(false);
  const [sharing, setSharing] = useState(false);
  // Set once a scene is on screen; a view is only counted from then on.
  const [shown, setShown] = useState(false);
  const surface = embed ? 'embed' : 'page';
  const trackViewerEvent = useViewerAnalytics(tour.tourId, surface, shown);

  if (!scene || failed || (single && !requestedOk)) return <Unavailable embed={embed} />;

  const panoId = scene.id;
  const hotspots = (vt.hotspots[panoId] ?? []).map(toHotspot);
  const links: ViewerLinkArrow[] = single
    ? []
    : (vt.links[panoId] ?? []).map((l) => ({
        to: l.to,
        yaw: l.yaw,
        label: l.label ?? vt.titles[l.to] ?? '',
      }));
  const go = (id: string, view: Scene['view']) => {
    setActive(null);
    setScene({ id, view });
  };
  const scenes = Object.keys(vt.tour?.scenes ?? {}).map((id) => ({
    id,
    title: vt.titles[id] ?? id,
    ...vt.mapPositions[id],
  }));
  const { controls, showCompass, showMap } = vt.settings;

  return (
    <div ref={frame} className={`tour-page tour-view${embed ? ' tour-view--embed' : ''}`}>
      {tour.visibility === 'unlisted' && <meta name="robots" content="noindex" />}
      <title>{`${tour.title} · panote`}</title>
      <PanoStage
        baseUrl={tilesBaseUrl(config)}
        panoId={panoId}
        {...(scene.view && { view: scene.view })}
        north={vt.north[panoId] ?? 0}
        autoRotate={autoRotate}
        transition
        {...(createViewer && { createViewer })}
        aria-label={`${tour.title}: ${vt.titles[panoId] ?? ''}`}
        onSceneChange={(id) => {
          setShown(true);
          trackViewerEvent({ type: 'scene', panoId: id });
        }}
        onHotspotOpen={(hotspotId) => trackViewerEvent({ type: 'hotspot', panoId, hotspotId })}
        onLoadError={(err) => {
          console.error('pano load failed', err);
          // Nothing on screen yet (e.g. the manifest 404s): same placeholder as a missing tour.
          if (!shown) setFailed(true);
        }}
      >
        <PointsLayer
          isAllowedMediaUrl={isCdnUrl}
          panoId={panoId}
          hotspots={hotspots}
          links={links}
          active={active}
          setActive={setActive}
          onGo={(link) => go(link.to, { yaw: link.yaw })}
        />
        {!embed && (
          <div className="tour-bar">
            <Link to="/" className="tour-bar__home" aria-label="panote home">
              <LogoMark size={30} />
            </Link>
            <nav className="tour-crumbs" aria-label="Tour">
              <span className="tour-crumbs__tour">{tour.title}</span>
              <i className="fa-solid fa-chevron-right tour-crumbs__sep" aria-hidden="true" />
              <span className="tour-crumbs__scene" aria-current="location">
                {vt.titles[panoId]}
              </span>
            </nav>
            {shown && <TourStats tourId={tour.tourId} visible view={{ panoId, surface }} />}
            <OwnerEdit tourId={tour.tourId} />
          </div>
        )}
        {embed && shown && (
          <TourStats tourId={tour.tourId} visible={false} view={{ panoId, surface }} />
        )}
        {embed && !single && (
          <a className="tour-embed-brand" href={`/s/${tour.slug}`} target="_blank" rel="noopener">
            <Logo />
          </a>
        )}
        {showCompass && <Compass className="tour-compass" />}
        {showMap && !single && scenes.length > 1 && (
          <SceneMap
            scenes={scenes}
            current={panoId}
            onSelect={(id) => go(id, vt.tour?.scenes[id]?.initialView)}
          />
        )}
        <ViewerControls
          fullscreenTarget={frame}
          autoRotate={autoRotate}
          onAutoRotateChange={setAutoRotate}
          position={controls}
        >
          {/* Visitor share sheet (design README 7); the embed links back here instead. */}
          {!embed && (
            <button
              type="button"
              className="pn-controls__btn"
              aria-label="Share"
              aria-haspopup="dialog"
              onClick={() => {
                // The sheet portals to <body>, which a fullscreen stage would hide.
                if (document.fullscreenElement) void document.exitFullscreen();
                setSharing(true);
              }}
            >
              <i className="fa-solid fa-share-nodes" aria-hidden="true" />
            </button>
          )}
        </ViewerControls>
      </PanoStage>
      {!embed && (
        <ShareModal
          open={sharing}
          onClose={() => setSharing(false)}
          variant="visitor"
          siteOrigin={config.siteOrigin}
          title={tour.title}
          slug={tour.slug}
          visibility={tour.visibility}
        />
      )}
    </div>
  );
}
