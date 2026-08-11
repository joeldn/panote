/**
 * The default texture budget, in MB, for a viewer whose caller did not name
 * one — scaled by the device pixel ratio the renderer will actually draw at.
 *
 * Why it has to scale at all. The budget buys a tile count: tile-layer.ts turns
 * MB into `maxTiles` by dividing by the bytes one tile occupies, and a tile is
 * one RGBA8 texture of `tileSize²` texels — 512² × 4 = 1 MiB, 1024² × 4 = 4 MiB.
 * (Mip levels add ~33% on top of that in real VRAM; the budget counts base-level
 * bytes, as it always has.) So 128 MB is 128 tiles at `tileSize` 512 and 32 at
 * 1024, and scaling the budget scales the tile count identically for both.
 *
 * The tile count the viewer *needs* is set by the pyramid level, and the level
 * is chosen from the framebuffer's device-pixel height (see `selectLevel` in
 * packages/core/src/lod.ts, and PanoViewer's `update()` call). On a DPR-2
 * display that is one level finer than on DPR 1, and one level finer is four
 * times as many tiles on screen: the measured visible set for a 70° FOV on an
 * 800 CSS-px-tall viewport goes from 24 tiles at level 2 to 88 at level 3. A
 * flat 128-tile budget is 5.3× the visible set in the first case and 1.45× in
 * the second — too tight to pan without evicting tiles that are about to be
 * wanted again, which costs a re-decode and a re-upload every frame.
 *
 * Why the scale is the pixel ratio and not its square. Matching the 4× growth
 * in tile count would mean 512 MB of textures on a phone, and GPU memory is the
 * one budget a viewer cannot borrow against — exceeding it does not slow the
 * page down, it loses the WebGL context. Linear in the pixel ratio, capped at
 * `MAX_BUDGET_PIXEL_RATIO`, gives DPR-2 displays 256 MB / 256 tiles ≈ 2.9× the
 * visible set: enough headroom that ordinary panning reuses tiles instead of
 * refetching them, while the worst case stays bounded at twice what a DPR-1
 * display already spends. Full sharpness is kept either way — this changes only
 * how much of it is retained.
 *
 * The cap is a constant here rather than `maxPixelRatio` alone, because
 * `maxPixelRatio` is the caller's *rendering* choice: raising it to 3 asks for a
 * sharper framebuffer, not for 384 MB of textures. `maxPixelRatio` still applies
 * as an upper bound, since a viewer that renders at most 1× device pixels also
 * selects levels as if it were a DPR-1 display and so needs no extra budget.
 */
export const BASE_TEXTURE_BUDGET_MB = 128;

/** Highest pixel ratio the default budget is allowed to scale by. */
export const MAX_BUDGET_PIXEL_RATIO = 2;

/** A positive, finite number, or `fallback` for anything else. */
function positive(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * The default texture budget in MB for a display of `devicePixelRatio`, on a
 * viewer that renders at most `maxPixelRatio` device pixels per CSS pixel.
 *
 * `devicePixelRatio` may be `undefined` (or 0, or `NaN`) — a non-browser host,
 * or an environment that does not report one — and is then treated as 1, which
 * reproduces the pre-scaling budget exactly. The result is never below
 * `BASE_TEXTURE_BUDGET_MB`: a sub-1 pixel ratio renders fewer device pixels than
 * CSS pixels, but the level selection floor is level 0 and the base layer is
 * pinned, so there is nothing to be gained by shrinking the budget below what
 * a DPR-1 display gets.
 */
export function defaultTextureBudgetMB(
  devicePixelRatio: number | undefined,
  maxPixelRatio: number,
): number {
  const rendered = Math.min(
    positive(devicePixelRatio, 1),
    positive(maxPixelRatio, MAX_BUDGET_PIXEL_RATIO),
  );
  const scale = Math.min(Math.max(rendered, 1), MAX_BUDGET_PIXEL_RATIO);
  return BASE_TEXTURE_BUDGET_MB * scale;
}
