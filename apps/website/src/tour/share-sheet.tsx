import { useCopy, type CopyState } from '@internal/ui';
import type { ShareModalProps } from '@internal/ui/share';
import {
  Component,
  lazy,
  Suspense,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';

import { isChunkLoadError } from '../chunk-reload.js';
import { loadShare, shareChunk } from './share-chunk.js';

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
 * Suspense's fallback: reports that the sheet is on its way for as long as it is mounted.
 * A layout effect, so Share stops spinning in the same frame the sheet appears. A chunk
 * that keeps an open sheet waiting `shareChunk.stallMs` calls `onStall`.
 */
function Pending({
  open,
  onPending,
  onStall,
}: {
  open: boolean;
  onPending: ((pending: boolean) => void) | undefined;
  onStall: (stalled: boolean) => void;
}) {
  useLayoutEffect(() => {
    onPending?.(true);
    return () => onPending?.(false);
  }, [onPending]);
  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => onStall(true), shareChunk.stallMs);
    return () => clearTimeout(timer);
  }, [open, onStall]);
  return null;
}

export interface LazyShareSheetProps extends ShareModalProps {
  /** A published tour's: the fallback always has a link to offer. */
  slug: string;
  /** True while the sheet's chunk is loading, false once it is up or has failed. */
  onPending?: (pending: boolean) => void;
}

/**
 * The visitor ShareModal, loaded on demand. A chunk that fails to load (say, gone after a
 * deploy) is retried once; if that fails too, or the sheet throws, a plain copyable link
 * shows instead. So it does while a chunk that hangs keeps the open sheet waiting; the
 * next Share tries the sheet again. Unlike the lazy routes this never reloads the page:
 * the visitor is in the middle of a tour.
 */
export function LazyShareSheet({ onPending, ...props }: LazyShareSheetProps) {
  const [attempt, setAttempt] = useState<Attempt>('first');
  const [sheets] = useState(lazySheets);
  const [stalled, setStalled] = useState(false);
  if (stalled && !props.open) setStalled(false);
  if (attempt === 'failed' || stalled) return props.open ? <ShareFallback {...props} /> : null;
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
      <Suspense fallback={<Pending open={props.open} onPending={onPending} onStall={setStalled} />}>
        <Sheet {...props} />
      </Suspense>
    </SheetBoundary>
  );
}

// The share URL, as links.ts's shareUrl builds it (that module is in the lazy chunk).
const shareUrl = (siteOrigin: string, slug: string) =>
  `${siteOrigin.replace(/\/+$/, '')}/s/${encodeURIComponent(slug)}`;

const copyLabel = (state: CopyState): string =>
  state === 'copied' ? 'Copied ✓' : state === 'failed' ? 'Copy failed' : 'Copy link';

/**
 * The plain link, for when the sheet can't load. Focus moves in on open and goes back to
 * what had it (the Share button) on close; Escape closes it.
 */
function ShareFallback({ onClose, siteOrigin, slug }: Omit<LazyShareSheetProps, 'onPending'>) {
  const url = shareUrl(siteOrigin, slug);
  const [copied, copy] = useCopy();
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    first.current?.focus();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    onClose();
  };
  return (
    <div className="tour-share-fallback" role="alert" onKeyDown={onKeyDown}>
      <p>
        Couldn&apos;t open sharing. Reload the page to try again, or copy this link:{' '}
        <a href={url}>{url.replace(/^https?:\/\//, '')}</a>
      </p>
      <button
        ref={first}
        type="button"
        className="tour-share-fallback__btn"
        onClick={() => void copy(url)}
      >
        {copyLabel(copied)}
      </button>
      <button
        type="button"
        className="tour-share-fallback__btn tour-share-fallback__btn--quiet"
        onClick={onClose}
      >
        Close
      </button>
    </div>
  );
}
