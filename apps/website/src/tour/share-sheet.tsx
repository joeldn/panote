import type { ShareModalProps } from '@internal/ui/share';
import { Component, lazy, Suspense, useState, type ReactNode } from 'react';

import { isChunkLoadError } from '../chunk-reload.js';
import { loadShare } from './share-chunk.js';

const lazySheet = () => lazy(async () => ({ default: (await loadShare()).ShareModal }));
// A rejected lazy() stays rejected, so the retry needs its own. Made per mount, so a
// remount (or the next test) starts from a fresh pair.
const lazySheets = () => ({ first: lazySheet(), retry: lazySheet() });

/** Catches the sheet's failure so it never reaches the tour route's error element. */
class SheetBoundary extends Component<
  { children: ReactNode; onError: (error: unknown) => void },
  { failed: boolean }
> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override componentDidCatch(error: unknown) {
    this.props.onError(error);
  }
  override render() {
    return this.state.failed ? null : this.props.children;
  }
}

type Attempt = 'first' | 'retry' | 'failed';

/**
 * The visitor ShareModal, loaded on demand. A chunk that fails to load (say, gone after a
 * deploy) is retried once; if that fails too, or the sheet throws, a plain copyable link
 * shows instead. Unlike the lazy routes this never reloads the page: the visitor is in
 * the middle of a tour.
 */
export function LazyShareSheet(props: ShareModalProps) {
  const [attempt, setAttempt] = useState<Attempt>('first');
  const [sheets] = useState(lazySheets);
  if (attempt === 'failed') return props.open ? <ShareFallback {...props} /> : null;
  const Sheet = attempt === 'first' ? sheets.first : sheets.retry;
  return (
    <SheetBoundary
      key={attempt}
      onError={(error) => {
        if (attempt === 'first' && isChunkLoadError(error)) {
          setAttempt('retry');
          return;
        }
        console.error('share sheet failed to load', error);
        setAttempt('failed');
      }}
    >
      <Suspense fallback={null}>
        <Sheet {...props} />
      </Suspense>
    </SheetBoundary>
  );
}

// The share URL, as links.ts's shareUrl builds it (that module is in the lazy chunk).
const shareUrl = (siteOrigin: string, slug: string) =>
  `${siteOrigin.replace(/\/+$/, '')}/s/${encodeURIComponent(slug)}`;

function ShareFallback({ onClose, siteOrigin, slug }: ShareModalProps) {
  const url = slug ? shareUrl(siteOrigin, slug) : null;
  return (
    <div className="tour-share-fallback" role="alert">
      <p>
        Couldn&apos;t open sharing. Reload the page to try again
        {url ? (
          <>
            , or copy this link: <a href={url}>{url.replace(/^https?:\/\//, '')}</a>
          </>
        ) : (
          '.'
        )}
      </p>
      <button type="button" className="tour-share-fallback__close" onClick={onClose}>
        Close
      </button>
    </div>
  );
}
