import { HotspotMediaSchema, VIMEO_HASH_PATTERN, type HotspotMedia } from '@internal/contracts';

/** The editor's media picker: YouTube and Vimeo share one choice, as in the design. */
export type MediaChoice = 'image' | 'audio' | 'video' | 'embed' | 'link';

export const choiceOf = (m: HotspotMedia): MediaChoice =>
  m.kind === 'youtube' || m.kind === 'vimeo' ? 'embed' : m.kind;

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be']);
const VIMEO_ID = /^\d{1,15}$/;
const VIMEO_HOSTS = new Set(['vimeo.com', 'www.vimeo.com', 'player.vimeo.com']);

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

/**
 * A Vimeo video id (and an unlisted video's hash) from a page, channel,
 * showcase or player URL: vimeo.com/123, vimeo.com/123/abc, .../video/123?h=abc.
 */
export function vimeoVideo(input: string): { id: string; hash?: string } | null {
  const s = input.trim();
  if (!URL.canParse(s)) return null;
  const url = new URL(s);
  if (!VIMEO_HOSTS.has(url.hostname)) return null;
  const parts = url.pathname.split('/').filter(Boolean);
  const after = parts.indexOf('video');
  const at = after >= 0 ? after + 1 : parts.findIndex((p) => VIMEO_ID.test(p));
  const id = parts[at];
  if (!id || !VIMEO_ID.test(id)) return null;
  const hash = url.searchParams.get('h') ?? parts[at + 1];
  // Only a segment shaped like an unlisted hash is one: vimeo.com/123/settings isn't.
  return hash && VIMEO_HASH_PATTERN.test(hash) ? { id, hash } : { id };
}

function embedOf(input: string): HotspotMedia | null {
  const yt = youtubeId(input);
  if (yt) return { kind: 'youtube', id: yt };
  const vimeo = vimeoVideo(input);
  return vimeo ? { kind: 'vimeo', ...vimeo } : null;
}

export type MediaParse = { ok: true; media: HotspotMedia } | { ok: false; message: string };

/**
 * Turn the editor's choice + text field into stored media, or say why it can't
 * be. With `detect`, a YouTube or Vimeo page pasted as an image, audio or video
 * is the video itself, so it is stored as an embed; as a link it stays a link.
 */
export function parseMedia(choice: MediaChoice, input: string, detect = true): MediaParse {
  const detected = detect && choice !== 'link' && URL.canParse(input.trim());
  if (choice === 'embed' || detected) {
    const embed = embedOf(input);
    if (embed) return { ok: true, media: embed };
    if (choice === 'embed') return { ok: false, message: 'Paste a YouTube or Vimeo link.' };
  }
  const parsed = HotspotMediaSchema.safeParse({ kind: choice, url: input });
  if (parsed.success) return { ok: true, media: parsed.data };
  return { ok: false, message: 'Use a full https:// link.' };
}

export function mediaInput(m: HotspotMedia): string {
  if (m.kind === 'youtube') return m.id;
  if (m.kind === 'vimeo') return `https://vimeo.com/${m.id}${m.hash ? `/${m.hash}` : ''}`;
  return m.url;
}
