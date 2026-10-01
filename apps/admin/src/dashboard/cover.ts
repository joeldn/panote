import type { PanoSummary } from './types.js';

const seg = (s: string): string => encodeURIComponent(s);

/**
 * A card cover from the pano's tiles: the equirect preview when the tiler wrote one,
 * else the level-0 front face. Mirrors previewUrl/tilePath in @panote/core.
 */
export function coverUrl(tilesBase: string, pano: PanoSummary | undefined): string | null {
  if (!pano || pano.deleting || !pano.manifest) return null;
  const { version, format, preview } = pano.manifest;
  const dir = `${tilesBase}${seg(pano.panoId)}/${version !== undefined ? `${seg(version)}/` : ''}`;
  return preview ? `${dir}preview.webp` : `${dir}0/pz/0-0.${format}`;
}

/** A stable hue per tour for the no-cover fallback, like the design's placeholder covers. */
export function fallbackHue(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
  return h;
}
