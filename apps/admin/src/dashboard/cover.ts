import type { PanoSummary } from './types.js';

const seg = (s: string): string => encodeURIComponent(s);

// FRONT_FACE in @panote/core: the face ahead at yaw 0 (the viewer looks along -z).
const FRONT_FACE = 'nz';

/** A cover image, and whether it has to be flipped left to right to read the right way round. */
export interface Cover {
  src: string;
  /**
   * True for a cube face tile. The tiler lays faces out as faceUVToDir in @panote/core
   * says, and on nz image-space u runs towards -x, while the viewer's right at yaw 0 is
   * +x: shown flat, a face is the mirror image of what the viewer shows. The equirect
   * preview runs the same way as the viewer, so it is never mirrored.
   */
  mirrored: boolean;
}

/**
 * A card cover from the pano's tiles: the equirect preview when the tiler wrote one,
 * else the level-0 front face. Mirrors previewUrl/tilePath in @panote/core.
 */
export function coverImage(tilesBase: string, pano: PanoSummary | undefined): Cover | null {
  if (!pano || pano.deleting || !pano.manifest) return null;
  const { version, format, preview } = pano.manifest;
  const dir = `${tilesBase}${seg(pano.panoId)}/${version !== undefined ? `${seg(version)}/` : ''}`;
  return preview
    ? { src: `${dir}preview.webp`, mirrored: false }
    : { src: `${dir}0/${FRONT_FACE}/0-0.${format}`, mirrored: true };
}

/** Undoes a cover's mirroring: the style for its `<img>`. */
export const coverStyle = (cover: Cover): { transform: string } | undefined =>
  cover.mirrored ? { transform: 'scaleX(-1)' } : undefined;

/** A stable hue per tour for the no-cover fallback, like the design's placeholder covers. */
export function fallbackHue(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
  return h;
}
