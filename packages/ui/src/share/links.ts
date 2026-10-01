import { SLUG_MAX_LENGTH } from '@internal/contracts';

export type ShareTab = 'link' | 'privacy' | 'embed';
export const SHARE_TABS: readonly ShareTab[] = ['link', 'privacy', 'embed'];

export type EmbedScope = 'tour' | 'pano';

/** Embed heights (design README 8, "Height"). */
export const EMBED_HEIGHTS = [
  { value: 380, label: 'Compact' },
  { value: 480, label: 'Standard' },
  { value: 660, label: 'Large' },
] as const;
export type EmbedHeight = (typeof EMBED_HEIGHTS)[number]['value'];
export const DEFAULT_EMBED_HEIGHT: EmbedHeight = 480;

const trimOrigin = (origin: string): string => origin.replace(/\/+$/, '');

/** `https://panote.io/s/<slug>`; the site origin comes from `VITE_SITE_ORIGIN`. */
export const shareUrl = (siteOrigin: string, slug: string): string =>
  `${trimOrigin(siteOrigin)}/s/${encodeURIComponent(slug)}`;

/** The link as the modal shows it: no scheme, `panote.io/s/<slug>`. */
export const displayUrl = (url: string): string => url.replace(/^https?:\/\//, '');

/** `https://panote.io/s/<slug>/embed[?pano=<panoId>]` (design README 8, "Embed"). */
export function embedSrc(siteOrigin: string, slug: string, panoId?: string | null): string {
  const base = `${shareUrl(siteOrigin, slug)}/embed`;
  return panoId ? `${base}?pano=${encodeURIComponent(panoId)}` : base;
}

/** The iframe snippet, byte for byte the design's format. */
export function embedSnippet(src: string, height: number): string {
  return (
    `<iframe src="${src}"\n` +
    `  width="100%" height="${height}" style="border:0"\n` +
    `  allow="fullscreen; xr-spatial-tracking"></iframe>`
  );
}

export interface SocialTarget {
  id: 'x' | 'facebook' | 'linkedin' | 'whatsapp';
  label: string;
  icon: string;
  href: string;
}

/** The four share intents from the design, in its order. */
export function socialTargets(url: string, title: string): SocialTarget[] {
  const u = encodeURIComponent(url);
  const t = encodeURIComponent(title);
  return [
    {
      id: 'x',
      label: 'X',
      icon: 'fa-brands fa-x-twitter',
      href: `https://twitter.com/intent/tweet?url=${u}&text=${t}`,
    },
    {
      id: 'facebook',
      label: 'Facebook',
      icon: 'fa-brands fa-facebook-f',
      href: `https://www.facebook.com/sharer/sharer.php?u=${u}`,
    },
    {
      id: 'linkedin',
      label: 'LinkedIn',
      icon: 'fa-brands fa-linkedin-in',
      href: `https://www.linkedin.com/sharing/share-offsite/?url=${u}`,
    },
    {
      id: 'whatsapp',
      label: 'WhatsApp',
      icon: 'fa-brands fa-whatsapp',
      href: `https://wa.me/?text=${t}%20${u}`,
    },
  ];
}

/**
 * Normalise while typing: like `normalizeSlug`, but keeps one trailing `-` so
 * a dash can be typed before the next word. Commit runs the full normaliser.
 */
export const typingSlug = (raw: string): string =>
  raw
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+/, '')
    .slice(0, SLUG_MAX_LENGTH);
