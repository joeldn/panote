import {
  localizePublishedTour,
  pickLanguage,
  tourLanguageList,
  type PublishedTour,
  type ViewBeacon,
} from '@internal/contracts';
import { Logo, LogoMark, TourViewer } from '@internal/ui';
import { publishedToViewerTour, tilesBaseUrl } from '@internal/web-kit';
import { useContext, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';

import './tour.css';

import { useAuthEnv } from '../auth-context.js';
import { useConfig } from '../config-context.js';
import { useViewerAnalytics } from './analytics.js';
import { reportHref } from './report.js';
import { prefetchShareSheet } from './share-chunk.js';
import { LazyShareSheet } from './share-sheet.js';
import { StageFactoryContext } from './stage-factory.js';
import { StatsChips } from './StatsChips.js';
import { Unavailable } from './Unavailable.js';
import { useIsOwner } from './use-owner.js';
import { useTourStats } from './use-stats.js';

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

/** Report, by mail with the share link filled in; never in the embed. */
function ReportLink({ slug }: { slug: string }) {
  const { siteOrigin } = useConfig();
  return (
    <a className="tour-report" href={reportHref(siteOrigin, slug)} aria-label="Report this tour">
      <i className="fa-solid fa-flag" aria-hidden="true" />
      <span className="tour-report__label">Report</span>
    </a>
  );
}

const browserLanguages = (): readonly string[] =>
  typeof navigator === 'undefined' ? [] : (navigator.languages ?? [navigator.language]);

/**
 * The page's `<html lang>` follows the tour's text while it is shown. Only for a tour
 * with languages: one without says nothing about the language it is written in.
 */
function useDocumentLang(lang: string | null) {
  useEffect(() => {
    if (!lang) return;
    const root = document.documentElement;
    const before = root.getAttribute('lang');
    root.setAttribute('lang', lang);
    return () => {
      if (before === null) root.removeAttribute('lang');
      else root.setAttribute('lang', before);
    };
  }, [lang]);
}

/** Screen 05: the visitor viewer, or the chrome-free embed. */
export function TourView({ tour: stored, embed }: { tour: PublishedTour; embed: boolean }) {
  const config = useConfig();
  const createViewer = useContext(StageFactoryContext);
  const [params, setParams] = useSearchParams();
  // ?lang= when the tour has it, else the browser's languages, else the default (Q4).
  const lang = pickLanguage(stored.languages, params.get('lang'), browserLanguages());
  const languages = useMemo(() => tourLanguageList(stored.languages), [stored.languages]);
  const tour = useMemo(() => localizePublishedTour(stored, lang), [stored, lang]);
  const vt = useMemo(() => publishedToViewerTour(tour), [tour]);
  useDocumentLang(lang);
  // Kept in the URL, so a reload or a copied link stays in the language picked.
  const chooseLanguage = (next: string) =>
    setParams(
      (p) => {
        const out = new URLSearchParams(p);
        out.set('lang', next);
        return out;
      },
      { replace: true },
    );

  const requested = params.get('pano');
  const requestedOk = requested !== null && !!vt.tour?.scenes[requested];
  // Embed ?pano= pins a single scene with no way out (design README:130).
  const single = embed && requested !== null;
  const start = requestedOk ? requested : (vt.tour?.start ?? null);

  const [failed, setFailed] = useState(false);
  const [sharing, setSharing] = useState(false);
  // Stays true after the first Share, so the sheet keeps its close transition.
  const [shareOpened, setShareOpened] = useState(false);
  // The sheet's chunk is still on its way.
  const [shareLoading, setShareLoading] = useState(false);
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
      // In someone else's page the wheel scrolls it until the visitor engages
      // the viewer; the full-page tour keeps every wheel for zooming.
      embed={embed}
      lang={lang}
      languages={languages}
      onLanguageChange={chooseLanguage}
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
          end: (
            <>
              <ReportLink slug={tour.slug} />
              <OwnerEdit tourId={tour.tourId} />
            </>
          ),
        },
        // Visitor share sheet (design README 7); the embed links back here instead.
        onShare: () => {
          setShareOpened(true);
          setSharing(true);
        },
        onShareIntent: prefetchShareSheet,
        sharePending: sharing && shareLoading,
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
      {!embed && shareOpened && (
        <LazyShareSheet
          open={sharing}
          onClose={() => setSharing(false)}
          onPending={setShareLoading}
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
