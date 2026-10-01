import { HotspotMediaSchema, type HotspotMedia } from '@internal/contracts';

export type MediaKind = HotspotMedia['kind'];

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be']);

/** A YouTube video id from a bare id or a watch/share/embed/shorts URL. */
export function youtubeId(input: string): string | null {
  const s = input.trim();
  if (YOUTUBE_ID.test(s)) return s;
  if (!URL.canParse(s)) return null;
  const url = new URL(s);
  if (!YOUTUBE_HOSTS.has(url.hostname)) return null;
  const candidate =
    url.hostname === 'youtu.be'
      ? url.pathname.slice(1)
      : (url.searchParams.get('v') ?? url.pathname.split('/').filter(Boolean)[1] ?? '');
  return YOUTUBE_ID.test(candidate) ? candidate : null;
}

export type MediaParse = { ok: true; media: HotspotMedia } | { ok: false; message: string };

/** Turn the editor's kind + text field into stored media, or say why it can't be. */
export function parseMedia(kind: MediaKind, input: string): MediaParse {
  if (kind === 'youtube') {
    const id = youtubeId(input);
    return id
      ? { ok: true, media: { kind, id } }
      : { ok: false, message: 'Paste a YouTube link or video id.' };
  }
  const parsed = HotspotMediaSchema.safeParse({ kind, url: input.trim() });
  if (parsed.success) return { ok: true, media: parsed.data };
  return { ok: false, message: 'Use a full https:// link.' };
}

export const mediaInput = (m: HotspotMedia): string => (m.kind === 'youtube' ? m.id : m.url);

/**
 * Whether the public viewer can show this inline. Its CSP only allows the CDN for
 * images and video, so anything else renders as a plain link there.
 */
export function isCdnMedia(m: HotspotMedia, cdnBase: string): boolean {
  if (m.kind === 'youtube') return true;
  return URL.canParse(m.url) && new URL(m.url).origin === new URL(cdnBase).origin;
}
