import type { PublishedTour } from '@internal/contracts';
import { loadPublishedTour } from '@internal/web-kit';
import { useEffect, useState } from 'react';

/** The showcase tour behind the hero: undefined while it loads, null when unset or unavailable. */
export function useShowcase(cdnBase: string | undefined, slug: string | null | undefined) {
  const key = cdnBase && slug ? `${cdnBase}|${slug}` : null;
  const [loaded, setLoaded] = useState<{ key: string; tour: PublishedTour | null } | null>(null);

  useEffect(() => {
    if (!cdnBase || !slug) return;
    const ac = new AbortController();
    const k = `${cdnBase}|${slug}`;
    loadPublishedTour(cdnBase, slug, { signal: ac.signal }).then(
      (result) => {
        if (!ac.signal.aborted)
          setLoaded({ key: k, tour: result.kind === 'tour' ? result.tour : null });
      },
      (err: unknown) => {
        // The landing works without its hero tour; plain background instead.
        if (ac.signal.aborted) return;
        console.warn('showcase tour failed to load', err);
        setLoaded({ key: k, tour: null });
      },
    );
    return () => ac.abort();
  }, [cdnBase, slug]);

  if (!key) return null;
  return loaded?.key === key ? loaded.tour : undefined;
}
