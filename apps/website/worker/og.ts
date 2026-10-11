import { FRONT_FACE, previewUrl, tilePath } from '@panote/core';

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

// What the tiler writes next to the tiles when the manifest says `preview: true`.
const EQUIRECT_PREVIEW = { width: 1024, height: 512, type: 'image/webp' } as const;
const TILE_TYPES = { jpg: 'image/jpeg', webp: 'image/webp' } as const;

/**
 * The start scene's own image, so no new asset is needed: the tiler's 1024×512 equirect
 * preview when it wrote one (2:1, close enough to the 1.91:1 large cards), else the
 * square level-0 front face (`nz`, ahead at yaw 0). Scrapers need an absolute https URL, so a CDN root that
 * isn't one gives no image.
 */
function previewImage(boot: TourBoot, tilesBase: string): PreviewImage | null {
  const { manifest, start } = boot;
  if (!manifest || start === null || !tilesBase.startsWith('https://')) return null;
  const alt = boot.tour.scenes.find((s) => s.panoId === start)?.config.title ?? boot.tour.title;
  if (manifest.preview) {
    return {
      url: previewUrl(tilesBase, manifest.pano, manifest.version),
      alt,
      ...EQUIRECT_PREVIEW,
    };
  }
  return {
    url: tilePath(tilesBase, manifest.pano, 0, FRONT_FACE, 0, 0, manifest.format, manifest.version),
    type: TILE_TYPES[manifest.format],
    width: manifest.tileSize,
    height: manifest.tileSize,
    alt,
  };
}

/**
 * The owner's description on one line (meta content has no line breaks), else a line
 * generated from the scene count for tours without one.
 */
export function tourDescription(description: string | undefined, sceneCount: number): string {
  const line = description?.replace(/\s+/g, ' ').trim();
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
  // Only a wide image suits the large card; a square tile or none gets the small one.
  const large = image !== null && image.width > image.height;
  tags.push(meta('twitter:card', large ? 'summary_large_image' : 'summary'));
  return tags.join('');
}
