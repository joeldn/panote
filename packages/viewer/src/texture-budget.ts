/**
 * The default texture budget, in MB, for a viewer whose caller did not name
 * one — scaled by the device pixel ratio the renderer will actually draw at.
 *
 * Why it has to scale at all. The budget buys a tile count: `maxTilesForBudget`
 * turns MB into `maxTiles` by dividing by the bytes one tile occupies in VRAM,
 * and a tile is one RGBA8 texture of `tileSize²` texels plus its full mip chain
 * (the renderer allocates every level), which adds a third: 512² × 4 × 4/3 =
 * 1.33 MiB, 1024² × 4 × 4/3 = 5.33 MiB. So 128 MB is 96 tiles at `tileSize` 512
 * and 24 at 1024, and scaling the budget scales the tile count identically for
 * both. The MB named here is the VRAM really spent on tile textures.
 *
 * The tile count the viewer *needs* is set by the pyramid level, and the level
 * is chosen from the framebuffer's device-pixel height (see `selectLevel` in
 * lod.ts, and the `layer.update()` call in PanoViewer's frame loop). On a DPR-2 display that is one
 * level finer than on DPR 1, and one level finer is about four times as many
 * tiles per degree: the measured visible set for a 70° FOV on an 800 CSS-px
 * tall 16:9 viewport is 12 tiles at level 1 on DPR 1 and 24 at level 2 on
 * DPR 2 (selectLevel's tolerance keeps both from rounding up a level). A flat
 * 128 MB budget (96 tiles) is 8× the visible set in the first case but only
 * 4× in the second, so a DPR-2 pan evicts tiles it is about to want again
 * twice as soon, and each one costs a refetch, a re-decode and a re-upload.
 *
 * Why the scale is the pixel ratio and not its square. Matching the 4× growth
 * in tile count would mean 512 MB of textures on a phone, and GPU memory is the
 * one budget a viewer cannot borrow against — exceeding it does not slow the
 * page down, it loses the WebGL context. Linear in the pixel ratio, capped at
 * `MAX_BUDGET_PIXEL_RATIO`, gives DPR-2 displays 256 MB / 192 tiles ≈ 8× the
 * visible set, the same headroom a DPR-1 display has, while the worst case
 * stays bounded at twice what a DPR-1 display already spends. Full sharpness
 * is kept either way — this changes only how much of it is retained.
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

/**
 * The default budget on a phone-class device, however dense its display.
 * iOS Safari gives a tab little memory, and running out loses the WebGL
 * context, which costs far more than refetching a tile. A phone's view is
 * also small: a 390 × 844 screen at a 70° fov shows 8 level-2 tiles, so 96
 * resident tiles is still a dozen views' worth.
 */
export const CONSTRAINED_TEXTURE_BUDGET_MB = 128;

/** Below this shorter screen side, in CSS px, a touch-first device is a phone or a small tablet. */
const SMALL_SCREEN_PX = 768;

/** The parts of `window` isConstrainedDevice reads. */
interface DeviceWindow {
  matchMedia?: (query: string) => { matches: boolean };
  screen?: { width: number; height: number };
}

/**
 * A phone-class device: a touch-first one whose screen's shorter side is
 * under 768 CSS px, or one whose `navigator.deviceMemory` (Chromium only, in
 * GB) is 4 or less. A desktop window made small keeps its full budget (its
 * pointer is fine), and so does a touch laptop or a full-size tablet.
 * Anything `win` or `nav` lacks, or throws on, counts as not known.
 */
export function isConstrainedDevice(
  win: DeviceWindow | undefined,
  nav: object | undefined,
): boolean {
  // Not in TypeScript's DOM lib.
  const memory = (nav as { deviceMemory?: unknown } | undefined)?.deviceMemory;
  if (typeof memory === 'number' && memory > 0 && memory <= 4) return true;
  const side = Math.min(win?.screen?.width ?? NaN, win?.screen?.height ?? NaN);
  if (!(side > 0 && side < SMALL_SCREEN_PX)) return false;
  try {
    return win?.matchMedia?.('(pointer: coarse)').matches === true;
  } catch {
    // An embed host with a broken matchMedia.
    return false;
  }
}

/** A positive, finite number, or `fallback` for anything else. */
function positive(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * The default texture budget in MB for a display of `devicePixelRatio`, on a
 * viewer that renders at most `maxPixelRatio` device pixels per CSS pixel,
 * held to CONSTRAINED_TEXTURE_BUDGET_MB on a `constrained` (phone-class)
 * device.
 *
 * `devicePixelRatio` may be `undefined` (or 0, or `NaN`) — a non-browser host,
 * or an environment that does not report one — and is then treated as 1,
 * which gives `BASE_TEXTURE_BUDGET_MB`. The result is never below
 * `BASE_TEXTURE_BUDGET_MB`: a sub-1 pixel ratio renders fewer device pixels than
 * CSS pixels, but the level selection floor is level 0 and the base layer is
 * pinned, so there is nothing to be gained by shrinking the budget below what
 * a DPR-1 display gets.
 */
export function defaultTextureBudgetMB(
  devicePixelRatio: number | undefined,
  maxPixelRatio: number,
  constrained = false,
): number {
  const rendered = Math.min(
    positive(devicePixelRatio, 1),
    positive(maxPixelRatio, MAX_BUDGET_PIXEL_RATIO),
  );
  const scale = Math.min(Math.max(rendered, 1), MAX_BUDGET_PIXEL_RATIO);
  const budget = BASE_TEXTURE_BUDGET_MB * scale;
  return constrained ? Math.min(budget, CONSTRAINED_TEXTURE_BUDGET_MB) : budget;
}

/** Mip levels add a third on top of the base level: 1 + 1/4 + 1/16 + … = 4/3. */
const MIP_CHAIN_FACTOR = 4 / 3;

/**
 * How many tiles of `tileSize`² fit in `budgetMB` of VRAM, counting each
 * tile's full mip chain as the renderer allocates it. Never below
 * `minResidentTiles`.
 */
export function maxTilesForBudget(
  budgetMB: number,
  tileSize: number,
  minResidentTiles: number,
): number {
  const tileMB = (tileSize * tileSize * 4 * MIP_CHAIN_FACTOR) / (1024 * 1024);
  return Math.max(minResidentTiles, Math.floor(budgetMB / tileMB));
}
