import { isHttpsMediaUrl } from '@internal/contracts';
import { useState } from 'react';

import type { ViewerMedia } from './types.js';

const YOUTUBE_EMBED = 'https://www.youtube-nocookie.com/embed/';
const VIMEO_EMBED = 'https://player.vimeo.com/video/';
// What the players need, and no more: their own scripts and storage, casting,
// and "Watch on YouTube" opening a normal tab. Never allow-top-navigation, so a
// compromised player can't move the tour page. Fullscreen isn't a sandbox flag:
// it comes from the `allow` attribute.
const PLAYER_SANDBOX =
  'allow-scripts allow-same-origin allow-presentation allow-popups allow-popups-to-escape-sandbox';

const LINK_LABEL = {
  image: 'Open image ↗',
  audio: 'Open audio ↗',
  video: 'Open video ↗',
} as const;

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function vimeoSrc(id: string, hash: string | undefined): string {
  // dnt=1 is Vimeo's do-not-track player: no cookies or session data, like youtube-nocookie.
  const params = new URLSearchParams({ dnt: '1' });
  if (hash) params.set('h', hash);
  return `${VIMEO_EMBED}${encodeURIComponent(id)}?${params}`;
}

function ExternalLink({ href, children }: { href: string; children: string }) {
  return (
    <a className="pn-hspanel__medialink" href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

export interface MediaEmbedProps {
  media: ViewerMedia;
  /** Names the embedded player for screen readers (the point's title). */
  title: string;
}

/**
 * A hotspot's linked media, shown inline: Panote links to it, never hosts it.
 * Nothing autoplays; image, audio and video that fail to load become a link.
 * Remount (key) it when the media changes, to clear a failed load.
 */
export function MediaEmbed({ media, title }: MediaEmbedProps) {
  const [broken, setBroken] = useState(false);
  // The players refuse to play without a referrer (YouTube error 153), so the
  // frames send the origin only; files and links send none.
  if (media.kind === 'youtube' || media.kind === 'vimeo') {
    return (
      <iframe
        className="pn-hspanel__media pn-hspanel__media--frame"
        src={
          media.kind === 'youtube'
            ? `${YOUTUBE_EMBED}${encodeURIComponent(media.id)}`
            : vimeoSrc(media.id, media.hash)
        }
        title={title}
        allow="encrypted-media; picture-in-picture; fullscreen"
        sandbox={PLAYER_SANDBOX}
        referrerPolicy="strict-origin-when-cross-origin"
        loading="lazy"
      />
    );
  }
  // The schema only stores plain https urls; a hand-built ViewerMedia is held to that too.
  if (!isHttpsMediaUrl(media.url)) return null;
  if (media.kind === 'link') {
    return <ExternalLink href={media.url}>{`Visit ${hostOf(media.url)} ↗`}</ExternalLink>;
  }
  if (broken) return <ExternalLink href={media.url}>{LINK_LABEL[media.kind]}</ExternalLink>;
  const onError = () => setBroken(true);
  if (media.kind === 'image') {
    return (
      <img
        className="pn-hspanel__media"
        src={media.url}
        alt=""
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={onError}
      />
    );
  }
  // <audio>/<video> have no referrerpolicy attribute; the page's
  // strict-origin-when-cross-origin policy sends the origin at most. The panel
  // only mounts on a tap, and metadata is enough to size it and catch a dead link.
  return media.kind === 'audio' ? (
    <audio
      className="pn-hspanel__media pn-hspanel__media--audio"
      src={media.url}
      controls
      preload="metadata"
      onError={onError}
    />
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
