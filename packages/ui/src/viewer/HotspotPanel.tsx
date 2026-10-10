import { renderMarkdown } from '@panote/viewer/ui';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';

import type { ViewerHotspot, ViewerMedia } from './types.js';

const YOUTUBE_EMBED = 'https://www.youtube-nocookie.com/embed/';

const LINK_LABEL = { image: 'Open image ↗', video: 'Open video ↗' } as const;

interface MediaProps {
  media: ViewerMedia;
  title: string;
  allowMedia: (url: string) => boolean;
}

function Media({ media, title, allowMedia }: MediaProps) {
  const [broken, setBroken] = useState(false);
  if (media.kind === 'youtube') {
    return (
      <iframe
        className="pn-hspanel__media pn-hspanel__media--frame"
        src={`${YOUTUBE_EMBED}${encodeURIComponent(media.id)}`}
        title={title}
        allow="encrypted-media; picture-in-picture; fullscreen"
        referrerPolicy="strict-origin-when-cross-origin"
        loading="lazy"
      />
    );
  }
  // Off-origin media would be blocked by the CSP, so it becomes a plain link instead.
  if (broken || !allowMedia(media.url)) {
    return (
      <a
        className="pn-hspanel__medialink"
        href={media.url}
        target="_blank"
        rel="noopener noreferrer"
      >
        {LINK_LABEL[media.kind]}
      </a>
    );
  }
  const onError = () => setBroken(true);
  return media.kind === 'image' ? (
    <img className="pn-hspanel__media" src={media.url} alt="" loading="lazy" onError={onError} />
  ) : (
    <video
      className="pn-hspanel__media"
      src={media.url}
      controls
      playsInline
      preload="metadata"
      onError={onError}
    />
  );
}

export interface HotspotPanelProps {
  hotspot: ViewerHotspot;
  onClose: () => void;
  /** Whether an image/video URL may load inline (the CSP allows only the CDN); else it's a link. */
  isAllowedMediaUrl?: (url: string) => boolean;
}

const NONE = () => false;

/** Info-point panel: a side panel on desktop, a bottom sheet at <=600px (CSS). */
export function HotspotPanel({ hotspot, onClose, isAllowedMediaUrl = NONE }: HotspotPanelProps) {
  // renderMarkdown escapes all HTML first and only allows http(s)/mailto/relative links.
  const html = useMemo(() => (hotspot.body ? renderMarkdown(hotspot.body) : ''), [hotspot.body]);

  // Keyboard and screen-reader users land in the panel when a point opens, and
  // go back to whatever opened it (the marker) when it closes. Switching points
  // while open re-focuses the panel and remembers the newer opener.
  const panel = useRef<HTMLElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const el = document.activeElement;
    if (el instanceof HTMLElement && el !== document.body && !panel.current?.contains(el)) {
      opener.current = el;
    }
    panel.current?.focus({ preventScroll: true });
  }, [hotspot.id]);
  useEffect(
    () => () => {
      if (opener.current?.isConnected) opener.current.focus({ preventScroll: true });
    },
    [],
  );
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    onClose();
  };

  return (
    <aside
      ref={panel}
      className="pn-hspanel"
      aria-label={hotspot.title}
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      <header className="pn-hspanel__head">
        <i
          className={`pn-hspanel__icon fa-solid fa-${hotspot.icon ?? 'info'}`}
          aria-hidden="true"
        />
        <h2 className="pn-hspanel__title">{hotspot.title}</h2>
        <button type="button" className="pn-hspanel__close" aria-label="Close" onClick={onClose}>
          ×
        </button>
      </header>
      {hotspot.media && (
        <Media
          key={hotspot.id}
          media={hotspot.media}
          title={hotspot.title}
          allowMedia={isAllowedMediaUrl}
        />
      )}
      {html && <div className="pn-hspanel__body" dangerouslySetInnerHTML={{ __html: html }} />}
    </aside>
  );
}
