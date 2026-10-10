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
  /** Extra buttons at the end of the pill (share, like). */
  children?: ReactNode;
}

/** The glass controls pill: zoom, fullscreen, auto-rotate. */
export function ViewerControls({
  fullscreenTarget,
  autoRotate,
  onAutoRotateChange,
  position = 'bottom',
  children,
}: ViewerControlsProps) {
  const viewer = usePanoViewer();
  const [fullscreen, setFullscreen] = useState(false);
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

  const zoom = (factor: number) => {
    if (viewer) viewer.setView({ fov: viewer.getView().fov * factor });
  };
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
        onClick={() => zoom(1 / ZOOM_STEP)}
      >
        <i className="fa-solid fa-minus" aria-hidden="true" />
      </button>
      <button
        type="button"
        className="pn-controls__btn"
        aria-label="Zoom in"
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
