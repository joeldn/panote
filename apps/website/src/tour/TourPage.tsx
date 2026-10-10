import { loadPublishedTour, type PublishedTourResult } from '@internal/web-kit';
import { useEffect, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router';

import { useConfig } from '../config-context.js';
import { TourView } from './TourView.js';
import { Unavailable } from './Unavailable.js';

type Loaded = { status: 'error' } | Exclude<PublishedTourResult, { kind: 'redirect' }>;

/**
 * The tour data the website Worker inlined for the slug it served (`#pn-boot`), parsed but
 * unvalidated; loadPublishedTour checks the slug and schemas and otherwise fetches.
 */
function workerBoot(): unknown {
  const text = document.getElementById('pn-boot')?.textContent;
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** `/s/:slug` and `/s/:slug/embed`: resolve the share link on the CDN, then show the tour. */
export function TourPage({ embed = false }: { embed?: boolean }) {
  const { slug = '' } = useParams();
  const { search } = useLocation();
  const navigate = useNavigate();
  const { cdnBase } = useConfig();
  const [attempt, setAttempt] = useState(0);
  // Results are keyed by request, so a new slug or retry reads as loading without a reset.
  const request = `${cdnBase}|${slug}|${embed}|${attempt}`;
  const [loaded, setLoaded] = useState<{ request: string; state: Loaded } | null>(null);
  const state = loaded?.request === request ? loaded.state : null;

  useEffect(() => {
    const ac = new AbortController();
    // A retry always goes to the network, in case the inlined data is what failed.
    const boot = attempt === 0 ? workerBoot() : null;
    loadPublishedTour(cdnBase, slug, { signal: ac.signal, boot }).then(
      (result) => {
        if (ac.signal.aborted) return;
        // Only reached without the website Worker (local dev); it 308s aliases itself.
        if (result.kind === 'redirect') {
          void navigate(`/s/${result.slug}${embed ? '/embed' : ''}${search}`, { replace: true });
        } else {
          setLoaded({ request, state: result });
        }
      },
      (err: unknown) => {
        if (ac.signal.aborted) return;
        console.error('tour load failed', err);
        setLoaded({ request, state: { status: 'error' } });
      },
    );
    return () => ac.abort();
    // `search` is read only when following an alias; a ?pano= change doesn't reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cdnBase, slug, embed, navigate, request, attempt]);

  if (state && 'kind' in state && state.kind === 'tour') {
    return <TourView key={state.tour.tourId} tour={state.tour} embed={embed} />;
  }
  if (state && 'kind' in state) return <Unavailable embed={embed} />;
  if (state?.status === 'error') {
    return <Unavailable embed={embed} retry={() => setAttempt((n) => n + 1)} />;
  }
  return (
    <div className="tour-page tour-page--loading" aria-busy="true">
      <meta name="robots" content="noindex" />
    </div>
  );
}
