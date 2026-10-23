import { useEffect, useState, type ReactNode, type RefObject } from 'react';

import { cx } from '../cx.js';
import { usePanoViewer } from '../viewer-context.js';

// Each step narrows or widens the vertical fov by this factor.
const ZOOM_STEP = 0.8;

export interface ViewerControlsProps {
  /** Element that goes fullscreen (usually the stage's wrapper). */
  fullscreenTarget?: RefObject<HTMLElement | null>;
  autoRotate?: boolean;
  onAutoRotateChange?: (on: boolean) => void;
  /** Tour setting `controls`: the pill sits at the bottom (default) or top. */
  position?: 'bottom' | 'top';
  /**
   * Where the target can't go fullscreen (iPhone Safari has no Fullscreen API on
   * elements, and an embed may not be allowed it): `'pseudo'` pins the target over
   * the whole viewport with the page's chrome hidden, `{ href }` offers a link that
   * opens that page in a new tab (an embed, where pinning would only fill the frame),
   * and `'none'` (the default) offers nothing.
   */
  fullscreenFallback?: 'pseudo' | { href: string } | 'none';
  /** Extra buttons at the end of the pill (share, like). */
  children?: ReactNode;
}

/** On the target while it is pinned over the viewport (see viewer.css). */
export const PSEUDO_FULLSCREEN_CLASS = 'pn-pseudo-fullscreen';

/** The glass controls pill: zoom, fullscreen (or its fallback), auto-rotate. */
export function ViewerControls({
  fullscreenTarget,
  autoRotate,
  onAutoRotateChange,
  position = 'bottom',
  fullscreenFallback = 'none',
  children,
}: ViewerControlsProps) {
  const viewer = usePanoViewer();
  const [fullscreen, setFullscreen] = useState(false);
  const [pseudo, setPseudo] = useState(false);
  // Offer fullscreen only when the document doesn't forbid it (false in an embed
  // without allow="fullscreen") and the target can actually request it: iPhone
  // Safari's elements can't, and some browsers only have a prefixed version.
  // Before mount the ref is empty, and the root element answers for it.
  const fullscreenEl = fullscreenTarget?.current ?? document.documentElement;
  const canFullscreen =
    (document.fullscreenEnabled as boolean | undefined) !== false &&
    typeof fullscreenEl.requestFullscreen === 'function';
  useEffect(() => {
    const sync = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', sync);
    return () => document.removeEventListener('fullscreenchange', sync);
  }, []);
  const pseudoOn = pseudo && !canFullscreen;
  useEffect(() => {
    const el = fullscreenTarget?.current;
    if (!pseudoOn || !el) return;
    el.classList.add(PSEUDO_FULLSCREEN_CLASS);
    // Escape leaves it, as it leaves real fullscreen. On window, so it hears the key after
    // a dialog open over it (whose listener is on document) has, and leaves one it handled.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) setPseudo(false);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      el.classList.remove(PSEUDO_FULLSCREEN_CLASS);
      window.removeEventListener('keydown', onKey);
    };
  }, [pseudoOn, fullscreenTarget]);

  // Stepped from the fov on screen, so no press is lost above the horizontal cap.
  const zoom = (factor: number) => viewer?.zoomBy(factor);
  const toggleFullscreen = () => {
    const el = fullscreenTarget?.current;
    // Either can still reject (permissions, no user gesture); nothing to do then.
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else if (el?.requestFullscreen) el.requestFullscreen().catch(() => {});
  };

  return (
    <div className={cx('pn-controls', `pn-controls--${position}`)} role="toolbar" aria-label="View">
      <button
        type="button"
        className="pn-controls__btn"
        aria-label="Zoom out"
        // Nothing to zoom without a viewer (none yet, or no WebGL2).
        disabled={!viewer}
        onClick={() => zoom(1 / ZOOM_STEP)}
      >
        <i className="fa-solid fa-minus" aria-hidden="true" />
      </button>
      <button
        type="button"
        className="pn-controls__btn"
        aria-label="Zoom in"
        disabled={!viewer}
        onClick={() => zoom(ZOOM_STEP)}
      >
        <i className="fa-solid fa-plus" aria-hidden="true" />
      </button>
      {fullscreenTarget && canFullscreen && (
        <button
          type="button"
          className="pn-controls__btn pn-controls__btn--accent"
          aria-label={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
          onClick={toggleFullscreen}
        >
          <i
            className={`fa-solid ${fullscreen ? 'fa-compress' : 'fa-expand'}`}
            aria-hidden="true"
          />
        </button>
      )}
      {fullscreenTarget && !canFullscreen && fullscreenFallback === 'pseudo' && (
        <button
          type="button"
          className="pn-controls__btn pn-controls__btn--accent"
          aria-label={pseudoOn ? 'Exit fullscreen' : 'Fullscreen'}
          onClick={() => setPseudo(!pseudoOn)}
        >
          <i className={`fa-solid ${pseudoOn ? 'fa-compress' : 'fa-expand'}`} aria-hidden="true" />
        </button>
      )}
      {!canFullscreen && typeof fullscreenFallback === 'object' && (
        <a
          className="pn-controls__btn pn-controls__btn--accent"
          href={fullscreenFallback.href}
          target="_blank"
          rel="noopener"
          aria-label="Open fullscreen in a new tab"
        >
          <i className="fa-solid fa-expand" aria-hidden="true" />
        </a>
      )}
      {onAutoRotateChange && (
        <button
          type="button"
          className="pn-controls__btn"
          aria-label="Auto-rotate"
          aria-pressed={!!autoRotate}
          onClick={() => onAutoRotateChange(!autoRotate)}
        >
          <i className="fa-solid fa-rotate" aria-hidden="true" />
        </button>
      )}
      {children}
    </div>
  );
}
