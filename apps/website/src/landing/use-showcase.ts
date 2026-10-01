import type { PublishedTour } from '@internal/contracts';
import { loadPublishedTour } from '@internal/web-kit';
import { useEffect, useState } from 'react';

/** The showcase tour behind the hero, or null while loading, unset or unavailable. */
export function useShowcase(cdnBase: string | undefined, slug: string | null | undefined) {
  const key = cdnBase && slug ? `${cdnBase}|${slug}` : null;
  const [loaded, setLoaded] = useState<{ key: string; tour: PublishedTour } | null>(null);

  useEffect(() => {
    if (!cdnBase || !slug) return;
    const ac = new AbortController();
    const k = `${cdnBase}|${slug}`;
    loadPublishedTour(cdnBase, slug, { signal: ac.signal }).then(
      (result) => {
        if (!ac.signal.aborted && result.kind === 'tour') setLoaded({ key: k, tour: result.tour });
      },
      (err: unknown) => {
        // The landing works without its hero tour; plain background instead.
        if (!ac.signal.aborted) console.warn('showcase tour failed to load', err);
      },
    );
    return () => ac.abort();
  }, [cdnBase, slug]);

  return loaded && loaded.key === key ? loaded.tour : null;
}
