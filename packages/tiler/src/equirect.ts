import { MAX_INPUT_PIXELS } from './pyramid.js';

/**
 * How build() decodes a source into the 2:1 equirect it tiles.
 *
 * A full 360x180 panorama is 2:1. Phones and many cameras also save partial
 * panoramas: a full 360 sweep but a narrower vertical field of view, so wider
 * than 2:1 (a 4:1 strip covers about 360x90). Stretching one of those over
 * the sphere squashes everything vertically. Instead the decode is padded top
 * and bottom to exactly 2:1, with the content centred on the horizon, and the
 * bands are filled from the content's edge colours (fillBands below).
 *
 * A source narrower than 2:1 is left as it is and still fills the sphere.
 * It is most likely an ordinary photo or a part-sweep panorama, and there is
 * no right answer for it: padding left and right would leave a black wedge
 * behind the viewer, and cropping would throw away content. The admin warns
 * the creator about both cases before the upload (apps/admin aspect-note.ts).
 */
export interface EquirectPlan {
  /** The decoded, padded image: what the faces, preview and og.jpg are cut from. */
  width: number;
  height: number;
  /** The source's rows, after any downscale, sit at [top, top + contentHeight). */
  top: number;
  contentHeight: number;
  /** True when the source is downscaled so the padded decode fits the pixel cap. */
  scaled: boolean;
}

/**
 * How much wider than 2:1 a source can be and still be tiled as it is, stretched
 * the way the tiler always has. Stitchers are often a few px off 2:1, and padding
 * those would change their tiles for nothing. Must match TOLERANCE in
 * apps/admin/src/upload/aspect-note.ts, which tells the creator when padding applies.
 */
export const ASPECT_TOLERANCE = 0.02;

/**
 * build() refuses a source whose long side is more than this many times its
 * short side. A 16:1 strip is a full sweep with a 22.5 degree vertical field of
 * view, narrower than any phone or camera panorama mode; a vertical sweep is
 * rarely past 1:4. Cost is not the reason: planEquirect already holds the padded
 * decode to MAX_INPUT_PIXELS, so a 65,536 x 2,288 strip (just under 150 MP)
 * becomes a 17,320 x 8,660 decode with 8,192 px faces, the same work as a real
 * 150 MP 2:1 panorama, and a source narrower than 2:1 gets faces from its width,
 * which the pixel cap keeps smaller still. It turns inputs that can only come out
 * as a sliver of image on a sphere into a clear, permanent failure instead of a
 * full job.
 */
export const MAX_ASPECT_RATIO = 16;

/**
 * Plans the decode of a width x height source. The caller has already checked
 * width * height against MAX_INPUT_PIXELS; padding makes the decoded buffer
 * bigger than the source, so the padded size is held to the same cap here,
 * before anything is decoded. A strip whose padded size would go over it is
 * downscaled to fit. That costs little: the face size comes from the width,
 * rounded up to a power of two, and the widest padded source the cap allows
 * (about 17,300 px) already gets the 8192 px faces a 30,000 px strip would.
 */
export function planEquirect(
  width: number,
  height: number,
  maxPixels: number = MAX_INPUT_PIXELS,
): EquirectPlan {
  const full = (w: number) => Math.round(w / 2);
  if (width <= 2 * height * (1 + ASPECT_TOLERANCE)) {
    return { width, height, top: 0, contentHeight: height, scaled: false };
  }
  let w = width;
  if (w * full(w) > maxPixels) {
    w = Math.floor(Math.sqrt(2 * maxPixels));
    while (w * full(w) > maxPixels) w--;
  }
  const h = full(w);
  const contentHeight =
    w === width ? height : Math.min(h, Math.max(1, Math.round((height * w) / width)));
  return {
    width: w,
    height: h,
    top: Math.floor((h - contentHeight) / 2),
    contentHeight,
    scaled: w !== width,
  };
}

/**
 * Fills the bands above and below the content of a padded RGB buffer, in place.
 * Each band starts as the content's edge row and fades, over its first quarter,
 * into the average colour of that row: sky above, ground below. Every pixel row
 * near a pole maps to almost the same point on the sphere, so a flat colour
 * there shows as a calm cap rather than the pinched streaks a stretched edge
 * would leave.
 */
export function fillBands(
  data: Uint8Array,
  width: number,
  height: number,
  top: number,
  contentHeight: number,
): void {
  const row = width * 3;
  const fill = (edgeY: number, ys: number[]) => {
    if (ys.length === 0) return;
    const edge = data.subarray(edgeY * row, (edgeY + 1) * row);
    const mean = [0, 0, 0];
    for (let i = 0; i < row; i++) mean[i % 3]! += edge[i]!;
    for (let c = 0; c < 3; c++) mean[c] = mean[c]! / width;
    const fade = Math.max(1, Math.ceil(ys.length / 4));
    ys.forEach((y, d) => {
      const t = Math.min(1, (d + 1) / fade);
      const o = y * row;
      for (let i = 0; i < row; i++) {
        data[o + i] = Math.round(edge[i]! * (1 - t) + mean[i % 3]! * t);
      }
    });
  };
  const bottom = top + contentHeight;
  // Nearest the content first, so d counts rows away from the edge.
  fill(
    top,
    Array.from({ length: top }, (_, i) => top - 1 - i),
  );
  fill(
    bottom - 1,
    Array.from({ length: height - bottom }, (_, i) => bottom + i),
  );
}
