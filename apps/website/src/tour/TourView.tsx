import type { PublishedTour, ViewBeacon } from '@internal/contracts';
import { Logo, LogoMark, ShareModal, TourViewer } from '@internal/ui';
import { publishedToViewerTour, tilesBaseUrl } from '@internal/web-kit';
import { useContext, useMemo, useState } from 'react';
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

// Inline media must come from the CDN: that is all the CSP's img-src/media-src allow.
// try/catch, not URL.canParse: that is Safari 17+, and this runs while rendering.
const cdnMatcher = (cdnBase: string) => {
  const cdn = new URL(cdnBase).origin;
  return (url: string): boolean => {
    try {
      return new URL(url).origin === cdn;
    } catch {
      return false;
    }
  };
};

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
    <a className="pn-tourbar__btn" href={`${origins.admin}/app/t/${encodeURIComponent(tourId)}`}>
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
  const isCdnUrl = useMemo(() => cdnMatcher(config.cdnBase), [config.cdnBase]);

  const requested = params.get('pano');
  const requestedOk = requested !== null && !!vt.tour?.scenes[requested];
  // Embed ?pano= pins a single scene with no way out (design README:130).
  const single = embed && requested !== null;
  const start = requestedOk ? requested : (vt.tour?.start ?? null);

  const [failed, setFailed] = useState(false);
  const [sharing, setSharing] = useState(false);
  // Set once a scene is on screen; a view is only counted from then on.
  const [shown, setShown] = useState(false);
  const surface = embed ? 'embed' : 'page';
  const trackViewerEvent = useViewerAnalytics(tour.tourId, surface, shown);

  if (!start || failed || (single && !requestedOk)) return <Unavailable embed={embed} />;

  return (
    <TourViewer
      {...(embed && { className: 'tour-view--embed' })}
      data={vt}
      title={tour.title}
      baseUrl={tilesBaseUrl(config)}
      start={start}
      single={single}
      isAllowedMediaUrl={isCdnUrl}
      {...(createViewer && { createViewer })}
      {...(!embed && {
        bar: {
          home: (
            <Link to="/" className="pn-tourbar__home" aria-label="panote home">
              <LogoMark size={30} />
            </Link>
          ),
          extras: (panoId: string) =>
            shown && <TourStats tourId={tour.tourId} visible view={{ panoId, surface }} />,
          end: <OwnerEdit tourId={tour.tourId} />,
        },
        // Visitor share sheet (design README 7); the embed links back here instead.
        onShare: () => setSharing(true),
      })}
      overlay={(panoId) =>
        embed && (
          <>
            {shown && <TourStats tourId={tour.tourId} visible={false} view={{ panoId, surface }} />}
            {!single && (
              <a
                className="tour-embed-brand"
                href={`/s/${tour.slug}`}
                target="_blank"
                rel="noopener"
              >
                <Logo />
              </a>
            )}
          </>
        )
      }
      onSceneChange={(id) => {
        setShown(true);
        trackViewerEvent({ type: 'scene', panoId: id });
      }}
      onHotspotOpen={(panoId, hotspotId) =>
        trackViewerEvent({ type: 'hotspot', panoId, hotspotId })
      }
      onLoadError={(err) => {
        console.error('pano load failed', err);
        // Nothing on screen yet (e.g. the manifest 404s): same placeholder as a missing tour.
        if (!shown) setFailed(true);
      }}
    >
      {tour.visibility === 'unlisted' && <meta name="robots" content="noindex" />}
      <title>{`${tour.title} · panote`}</title>
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
    </TourViewer>
  );
}
