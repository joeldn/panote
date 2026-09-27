import { renderMarkdown } from '@panote/viewer/ui';
import { useMemo } from 'react';

import type { ViewerHotspot, ViewerMedia } from './types.js';

const YOUTUBE_EMBED = 'https://www.youtube-nocookie.com/embed/';

function Media({ media, title }: { media: ViewerMedia; title: string }) {
  switch (media.kind) {
    case 'image':
      return <img className="pn-hspanel__media" src={media.url} alt="" loading="lazy" />;
    case 'video':
      return (
        <video
          className="pn-hspanel__media"
          src={media.url}
          controls
          playsInline
          preload="metadata"
        />
      );
    case 'youtube':
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
}

export interface HotspotPanelProps {
  hotspot: ViewerHotspot;
  onClose: () => void;
}

/** Info-point panel: a side panel on desktop, a bottom sheet at <=600px (CSS). */
export function HotspotPanel({ hotspot, onClose }: HotspotPanelProps) {
  // renderMarkdown escapes all HTML first and only allows http(s)/mailto/relative links.
  const html = useMemo(() => (hotspot.body ? renderMarkdown(hotspot.body) : ''), [hotspot.body]);
  return (
    <aside className="pn-hspanel" aria-label={hotspot.title}>
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
      {hotspot.media && <Media media={hotspot.media} title={hotspot.title} />}
      {html && <div className="pn-hspanel__body" dangerouslySetInnerHTML={{ __html: html }} />}
    </aside>
  );
}
