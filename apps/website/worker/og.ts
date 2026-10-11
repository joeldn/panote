import { ogImageUrl, previewUrl } from '@panote/core';

import type { TourBoot } from './boot.js';

/** For a double-quoted attribute value. `>` and `'` too, so no tag can ever be closed early. */
export const escapeAttr = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

interface PreviewImage {
  url: string;
  type: string;
  width: number;
  height: number;
  alt: string;
}

// What the tiler writes next to the tiles when the manifest says `og: true`: a
// normal-camera view of the scene, the size and type the large cards want.
const OG_IMAGE = { width: 1200, height: 630, type: 'image/jpeg' } as const;
// What the tiler writes next to the tiles when the manifest says `preview: true`.
const EQUIRECT_PREVIEW = { width: 1024, height: 512, type: 'image/webp' } as const;

/**
 * The start scene's own image: the tiler's 1200×630 og.jpg (a normal-camera view) when it
 * wrote one, else its 1024×512 equirect preview (2:1, close enough to the 1.91:1 large
 * cards), else none. Scrapers need an absolute https URL, so a CDN root that isn't one
 * gives no image either.
 *
 * There is deliberately no cube-face fallback: a face tile is stored mirrored left to right
 * (faceUVToDir in @panote/core), and a scraper can't flip it back, so it would show the
 * scene backwards. Only a pano tiled before preview.webp existed and never backfilled with
 * og.jpg lands here, and a text-only card beats a mirrored one.
 */
function previewImage(boot: TourBoot, tilesBase: string): PreviewImage | null {
  const { manifest, start } = boot;
  if (!manifest || start === null || !tilesBase.startsWith('https://')) return null;
  const alt = boot.tour.scenes.find((s) => s.panoId === start)?.config.title ?? boot.tour.title;
  if (manifest.og) {
    return { url: ogImageUrl(tilesBase, manifest.pano, manifest.version), alt, ...OG_IMAGE };
  }
  if (manifest.preview) {
    return {
      url: previewUrl(tilesBase, manifest.pano, manifest.version),
      alt,
      ...EQUIRECT_PREVIEW,
    };
  }
  return null;
}

// C0 controls, DEL and NEL (U+0085, a line break `\s` doesn't match).
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL = /[\u0000-\u001f\u007f\u0085]/g;

/**
 * The owner's description on one line (meta content has no line breaks), else a line
 * generated from the scene count for tours without one. The admin API only stores plain
 * text, but a hand-written bundle goes through a more lenient schema, so control
 * characters become spaces here too.
 */
export function tourDescription(description: string | undefined, sceneCount: number): string {
  const line = description?.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
  if (line) return line;
  if (sceneCount === 0) return 'A 360° virtual tour';
  return `A 360° virtual tour · ${sceneCount} ${sceneCount === 1 ? 'scene' : 'scenes'}`;
}

const meta = (key: string, content: string | number): string =>
  `<meta ${key.startsWith('og:') ? 'property' : 'name'}="${key}" content="${escapeAttr(String(content))}">`;

/**
 * Open Graph and Twitter card tags for a published tour's share link, public or unlisted
 * (sharing the link is what unlisted is for; its noindex is separate). `canonical` is
 * the tour's `/s/<slug>` URL, without the query or `/embed`. `tilesBase` is the CDN's
 * `tiles/` root, or null when the page has none.
 */
export function linkPreviewTags(
  boot: TourBoot,
  canonical: string,
  tilesBase: string | null,
): string {
  const description = tourDescription(boot.tour.description, boot.tour.scenes.length);
  const image = tilesBase === null ? null : previewImage(boot, tilesBase);
  const tags = [
    meta('description', description),
    meta('og:type', 'website'),
    meta('og:site_name', 'panote'),
    meta('og:title', boot.tour.title),
    meta('og:description', description),
    meta('og:url', canonical),
  ];
  if (image) {
    tags.push(
      meta('og:image', image.url),
      meta('og:image:type', image.type),
      meta('og:image:width', image.width),
      meta('og:image:height', image.height),
      meta('og:image:alt', image.alt),
    );
  }
  // Both images are wide, so they suit the large card; without one, the small one.
  tags.push(meta('twitter:card', image ? 'summary_large_image' : 'summary'));
  return tags.join('');
}
