import type { TourWithConfigsOk } from '@internal/contracts';
import { Chip, LogoMark, ShareModal, TourViewer } from '@internal/ui';
import { isAuthError, tilesBaseUrl, toViewerTour } from '@internal/web-kit';
import { useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';

import './preview.css';

import { useConfig } from '../config-context.js';
import { useSession } from '../session.js';
import { StageFactoryContext } from './stage-factory.js';

type Load =
  | { status: 'loading' }
  | { status: 'not-found' }
  | { status: 'error'; message: string }
  | { status: 'ready'; data: TourWithConfigsOk };

// Inline media must come from the CDN, as on the public viewer.
const cdnMatcher = (cdnBase: string) => {
  const cdn = new URL(cdnBase).origin;
  return (url: string): boolean => URL.canParse(url) && new URL(url).origin === cdn;
};

/** Route element for `/app/t/:tourId/preview` (screen 05, owner side). */
export function Preview() {
  const { tourId = '' } = useParams();
  return <TourPreview key={tourId} tourId={tourId} />;
}

/**
 * The tour as visitors will see it, from the owner's saved tour and configs, so
 * it works before the tour is published. No views, likes or analytics are sent.
 */
function TourPreview({ tourId }: { tourId: string }) {
  const { api } = useSession();
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    api.getTourWithConfigs(tourId).then(
      (res) => {
        if (!live) return;
        setLoad(
          res.status === 'ok' ? { status: 'ready', data: res.data } : { status: 'not-found' },
        );
      },
      (e: unknown) => {
        if (!live) return;
        // A 401 has already reopened sign-in (RequireAuth); this is what stays behind it.
        const message = isAuthError(e)
          ? 'Sign in again to preview this tour.'
          : 'Check your connection and try again.';
        setLoad({ status: 'error', message });
      },
    );
    return () => {
      live = false;
    };
  }, [api, tourId, attempt]);

  if (load.status === 'loading') return <PreviewMessage title="Loading preview…" />;
  if (load.status === 'not-found') {
    return (
      <PreviewMessage title="Tour not found">
        <p>
          It may have been deleted. <Link to="/">Back to your tours</Link>
        </p>
      </PreviewMessage>
    );
  }
  if (load.status === 'error') {
    return (
      <PreviewMessage title="Couldn’t load this tour">
        <p>
          {load.message}{' '}
          <button
            type="button"
            onClick={() => {
              setLoad({ status: 'loading' });
              setAttempt((n) => n + 1);
            }}
          >
            Try again
          </button>
        </p>
      </PreviewMessage>
    );
  }
  return <PreviewScreen tourId={tourId} data={load.data} />;
}

function PreviewMessage({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <main className="app-shell__main">
      <section className="placeholder" role={children ? 'alert' : 'status'}>
        <h1>{title}</h1>
        {children}
      </section>
    </main>
  );
}

function PreviewScreen({ tourId, data }: { tourId: string; data: TourWithConfigsOk }) {
  const config = useConfig();
  const createViewer = useContext(StageFactoryContext);
  const { tour: doc, configs, publish } = data;
  const vt = useMemo(() => toViewerTour(doc, configs), [doc, configs]);
  const isCdnUrl = useMemo(() => cdnMatcher(config.cdnBase), [config.cdnBase]);
  const [sharing, setSharing] = useState(false);
  // The scene whose tiles failed to load, e.g. one still processing.
  const [notReady, setNotReady] = useState<string | null>(null);
  const editor = `/t/${encodeURIComponent(tourId)}`;

  if (!vt.tour) {
    return (
      <PreviewMessage title="Nothing to preview yet">
        <p>
          Add a pano to this tour first. <Link to={editor}>Back to editor</Link>
        </p>
      </PreviewMessage>
    );
  }

  return (
    <TourViewer
      data={vt}
      title={doc.title}
      baseUrl={tilesBaseUrl(config)}
      start={vt.tour.start}
      isAllowedMediaUrl={isCdnUrl}
      {...(createViewer && { createViewer })}
      bar={{
        home: (
          <Link to="/" className="pn-tourbar__home" aria-label="Your tours">
            <LogoMark size={30} />
          </Link>
        ),
        extras: () => (
          <Chip tone="light" mono icon="fa-solid fa-eye" className="pv-badge">
            Preview
          </Chip>
        ),
        end: (
          <Link className="pn-tourbar__btn" to={editor}>
            Back to editor
          </Link>
        ),
      }}
      // Visitors' share sheet, once there is a live link to share.
      {...(publish && { onShare: () => setSharing(true) })}
      onSceneChange={() => setNotReady(null)}
      onLoadError={(err, panoId) => {
        console.error('pano load failed', err);
        setNotReady(panoId);
      }}
    >
      <title>{`${doc.title} · Preview · panote`}</title>
      {notReady && (
        <p className="pv-note" role="status">
          This pano’s tiles aren’t ready yet. They appear once processing finishes.
        </p>
      )}
      {publish && (
        <ShareModal
          open={sharing}
          onClose={() => setSharing(false)}
          variant="visitor"
          siteOrigin={config.siteOrigin}
          title={doc.title}
          slug={publish.slug}
          visibility={publish.visibility}
        />
      )}
    </TourViewer>
  );
}
