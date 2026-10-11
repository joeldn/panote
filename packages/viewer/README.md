# @panote/viewer

A cube-map panorama viewer for the browser. It draws a multiresolution tile pyramid with a small WebGL2 renderer and loads finer tiles as you zoom. It has no framework and no runtime dependencies.

It is what panote runs on, but it knows nothing about panote. You give it a **tile source**: where each tile comes from, or a function that makes it. The package is private and unpublished for now (`UNLICENSED`).

What it does:

- Shows a cube-map tile pyramid with power-of-two levels: level `L` has `2^L × 2^L` tiles per face, and level 0 is one tile per face.
- Can show an equirectangular preview while the tiles load.
- Handles pointer, wheel, keyboard, pinch and Safari gesture input, with camera limits, damping, inertia and idle auto-rotate.
- Crossfades from one scene to the next.
- Gives you projection helpers (`project`, `directionAtPixel`, `onRender`) so you can draw your own DOM over the panorama.

What it doesn't do (each of these would be an extension):

- non-power-of-two or ragged pyramids (a partial last tile);
- equirect tile pyramids;
- built-in hotspots or other DOM;
- video;
- WebGL1.

**Browser floor:** WebGL2, ES2023 (the build is not transpiled down) and `createImageBitmap`. Any current Chrome, Edge, Firefox (ESR included) or Safari meets it. Where WebGL2 is missing (disabled, or a blocklisted GPU), `new PanoViewer()` throws `WebGLUnavailableError`; check `isWebGL2Supported()` first, or catch it, to show a fallback.

## Quick start

```ts
import { PanoViewer, urlTemplateSource } from '@panote/viewer';

const viewer = new PanoViewer(document.getElementById('pano')!, {
  interaction: { label: 'Harbour at dusk' },
});

await viewer.load(
  urlTemplateSource({
    id: 'harbour',
    template: 'https://cdn.example/harbour/{level}/{face}/{x}-{y}.jpg',
    tileSize: 512,
    maxLevel: 3,
  }),
);
```

```css
#pano {
  position: relative;
  height: 70vh;
}
```

**Container requirements.** The container must be a positioned element (`relative`, `absolute` or `fixed`) with a size. The viewer adds a `<canvas>` to it, plus a full-size overlay during a `transitionTo` crossfade. It follows the container's size with a `ResizeObserver`, and it never styles the container. `dispose()` removes everything it added.

## Example

`examples/vanilla/` is a page with no framework that loads a small synthetic cube through `urlTemplateSource`. The cube has 6 faces and levels 0 and 1, and each face is labelled with its id and the direction you look to see it. From the repo root:

```sh
pnpm --filter @panote/viewer example        # vite dev server for the page
pnpm --filter @panote/viewer example:cube   # regenerate the cube PNGs (checked in)
```

## Tile sources

```ts
interface CubeTileSource {
  readonly id: string; // the payload of 'loading', 'scene-change' and 'load-error'
  readonly tileSize: number; // px, every tile at every level
  readonly maxLevel: number; // 0 to MAX_SOURCE_LEVEL (10)
  readonly version?: string; // compared with showPreview's replacesVersion
  tileUrl?(tile: TileAddress): string; // fetched with ViewerOptions.network
  loadTile?(tile: TileAddress, signal: AbortSignal): Promise<TileImage>; // full control
  readonly meta?: unknown; // yours, handed back in 'ready'
}
interface TileAddress {
  face: 'px' | 'nx' | 'py' | 'ny' | 'pz' | 'nz';
  level: number;
  x: number;
  y: number;
}
```

The rules a source follows:

- **Pyramid.** Each face is a square split into `2^level × 2^level` tiles of `tileSize` px, for every level from 0 to `maxLevel`. `x` and `y` count from the top left of the face. Level 0 is required. `load()` waits for the six level-0 tiles before the scene goes on screen, so every direction has at least a coarse texture, and a load whose base tiles can't be fetched rejects.
- **Images are upright.** Row 0 is the top of the tile. Don't decode with `imageOrientation: 'flipY'`. A `TileImage` is an `ImageBitmap`, an `HTMLCanvasElement` or an `OffscreenCanvas`. The viewer closes each `ImageBitmap` once it has been uploaded.
- **Face convention.** Texel `(u, v)` of a face, with `u` running left to right and `v` top to bottom (both 0 to 1), is shown in the direction `faceUVToDir(face, u, v)`. The camera at yaw 0 and pitch 0 looks at `-z` (the centre of `nz`), with `+x` to its right and `+y` up, and yaw grows to the right.

  | face | centre | `u` runs toward | `v` runs toward |
  |---|---|---|---|
  | `px` | `+x` | `-z` | `-y` |
  | `nx` | `-x` | `+z` | `-y` |
  | `py` | `+y` | `+x` | `+z` |
  | `ny` | `-y` | `+x` | `-z` |
  | `pz` | `+z` | `+x` | `-y` |
  | `nz` | `-z` | `-x` | `-y` |

  Under this convention a face image is the **mirror image** of what a camera at the centre sees: the side faces are flipped left to right. The example's `make-cube.ts` shows how to produce faces that read correctly. Cube tools that store each face as a photograph of that direction (krpano, Marzipano and Pannellum cubes, for example) need their faces flipped, which a `loadTile` can do while it draws them. Which flip each tool needs has not been verified.
- **Abort.** `loadTile` gets a signal and must reject with an `AbortError` once that signal aborts. The viewer aborts tiles that have left the view for a moment, along with superseded loads and everything still in flight when the viewer is disposed.
- **Errors.** Reject with a `TileHttpError(status)` to get HTTP retry handling: 408, 425, 429 and 5xx are transient, and any other status (a 404, a 401) is permanent and never retried. Any other rejection (a network error, a failed decode) is transient. Transient failures are retried up to `network.retry.maxAttempts` times with a doubling wait. A `tileUrl` source gets this automatically.

`urlTemplateSource({ id, template, tileSize, maxLevel, faceNames?, version?, meta? })` builds a source for the common static layout. It substitutes `{level}`, `{face}`, `{x}` and `{y}` into the template as given, without URL-encoding them. A cube with `maxLevel: 0` needs only `{face}`. Use `faceNames` to rename faces, e.g. `{ nz: 'front' }`.

**Ids instead of sources.** `load`, `transitionTo` and `prefetch` also accept a string id when you set `resolveSource: (id, signal, hints) => Promise<CubeTileSource>`. The resolver is where a manifest gets fetched and parsed. It must reject with an `AbortError` once `signal` aborts. `hints.priority` is `'low'` for a prefetch.

## Options

`new PanoViewer(container, options)` reads `options` once. Every field at every depth is optional, and an unset field takes the default below (`VIEWER_DEFAULTS`). `mergeViewerOptions(...layers)` deep-merges a preset with your overrides, and `resolveViewerOptions(options)` shows what a viewer built with them would run on. `autoRotate: true` is shorthand for `autoRotate: { enabled: true }`.

<!-- options-table: checked against VIEWER_DEFAULTS by src/readme.test.ts -->
| Option | Default | What it does |
|---|---|---|
| `resolveSource` | none | Turns ids into sources; without it, ids reject. |
| `initialView` | none | `{ yaw, pitch, fov }` before the first load; yaw and pitch start at 0, fov at `camera.defaultFov`. |
| `camera.minFov` | `15` | Narrowest vertical field of view, degrees. |
| `camera.maxFov` | `80` | Widest vertical field of view, degrees. |
| `camera.defaultFov` | `70` | Vertical fov when a view leaves it unset; clamped to the limits. |
| `camera.maxHorizontalFov` | `100` | Caps the horizontal fov on wide screens, degrees. |
| `camera.minPitch` | `-1.5697963267948967` | Lowest pitch, radians (−π/2 + 0.001). |
| `camera.maxPitch` | `1.5697963267948967` | Highest pitch, radians (π/2 − 0.001). |
| `camera.damping` | `0.25` | Easing toward the target per 60 Hz frame; 1 snaps. Scaled to the real frame time. |
| `camera.momentumFriction` | `0.9` | Fling inertia kept per 60 Hz frame. |
| `camera.north` | `0` | Compass north offset, radians; `setNorth()` changes it. |
| `interaction.enabled` | `true` | False builds no input handling: the camera moves only through the API. |
| `interaction.label` | `"Panorama viewer"` | The canvas's `aria-label`; `setLabel()` changes it. |
| `interaction.a11y` | `true` | Give the canvas `role="application"` (`"img"` when not interactive) and the label. |
| `interaction.cursor` | `true` | Grab and grabbing cursors over the canvas. |
| `interaction.wheel` | `"always"` | `"always"` zooms on every wheel; `"engaged"` (for embeds) lets a plain wheel scroll the page until the viewer is clicked, tapped or focused, while ctrl/cmd + wheel and pinch still zoom; `"off"` ignores the wheel. |
| `interaction.wheelGain` | `0.001` | ln(fov scale) per wheel pixel. |
| `interaction.pinchGain` | `0.01` | The same for a trackpad pinch (a ctrl-wheel with small deltas). |
| `interaction.keyboard.panStepPx` | `40` | Arrow-key pan step, screen px. `keyboard: false` ignores keys and drops the tab stop. |
| `interaction.keyboard.zoomStep` | `0.8` | Fov factor for `+`; `-` uses its inverse. |
| `interaction.doubleClickZoom` | `0.6` | Fov factor for a double click, toward the point; `false` ignores double clicks. |
| `interaction.inertia` | `true` | Keep gliding after a fling. |
| `rendering.maxPixelRatio` | `2` | Cap on `devicePixelRatio`. |
| `rendering.maxPixels` | `8300000` | Cap on backbuffer pixels (one 4K frame); above it the pixel ratio drops, which also picks a coarser level. |
| `rendering.antialias` | `false` | WebGL antialiasing. |
| `rendering.anisotropy` | `"max"` | Anisotropic filtering: a sample count, or the device's maximum. |
| `rendering.background` | `[0,0,0]` | Clear colour, 0 to 1 per channel, shown where no tile has loaded. |
| `rendering.lodBias` | `0` | Levels to shift tile selection by: positive is coarser (less bandwidth), negative is finer. Added to the viewer's own 0.2 tolerance. |
| `network.maxConcurrent` | `8` | Most tile requests in flight at once. |
| `network.fetch` | none | The fetch tile requests use; the global `fetch` when unset. Useful for auth or tests. |
| `network.requestInit` | `{}` | Spread into every tile request (mode, credentials, headers, cache). The viewer sets `signal` and `priority` itself. |
| `network.decode` | none | `(blob) => Promise<TileImage>`; `createImageBitmap(blob)` when unset. |
| `network.retry.maxAttempts` | `3` | Attempts per tile, counting the first, for a transient failure. |
| `network.retry.baseDelayMs` | `1000` | Wait before the first retry; it doubles each time. |
| `memory.textureBudgetMB` | `"auto"` | VRAM for resident tiles. `"auto"` is 128 MB at DPR 1, scaled with the rendered pixel ratio up to 256 MB at DPR 2. A number is used as given. |
| `memory.minResidentTiles` | `24` | Fewest tiles kept resident, whatever the budget. |
| `transition.durationMs` | `400` | `transitionTo()` crossfade, ms. |
| `transition.respectReducedMotion` | `true` | Cut instead of crossfading when the visitor prefers reduced motion. |
| `autoRotate.enabled` | `false` | Pan slowly when idle; `setAutoRotate()` toggles it. |
| `autoRotate.speed` | `0.036` | Radians of yaw per second. |
| `autoRotate.idleMs` | `3000` | Idle time before auto-rotate (re)starts after an interaction. |

## Methods

| Method | What it does |
|---|---|
| `load(source \| id, { view? })` | Loads the scene and swaps it in once its level-0 base is in. `view` is cut to at the swap, not eased to. Resolves `true` when the scene went on screen and `false` when a newer load, a preview, `cancelLoad()` or `dispose()` superseded it. Rejects (often with a `BaseTileLoadError`) only for a load that is still current. |
| `transitionTo(source \| id, view?)` | Like `load`, but crossfades from a snapshot of the old scene, taken at the swap: the old scene stays live until the new one is ready. |
| `cancelLoad()` | Cancels the load or transition in flight: its `load()` resolves `false` and the scene on screen stays as it is. |
| `showPreview(id, preview, { replacesVersion?, view? })` | Shows an equirect preview of `id` now and cancels any load in flight. Call `load(id)` afterwards to get the tiles. `view` is cut to as the preview goes up. |
| `prefetch(source \| id, { signal? })` | Warms the HTTP cache with the six base tiles of a scene the visitor may open next. Best effort: it never rejects. |
| `setView({ yaw?, pitch?, fov? })` / `getView()` | Eases the camera to a view, or reads the view it is moving to (yaw in (−π, π]). `getView().fov` is the fov requested, which on a wide viewport can be above what `camera.maxHorizontalFov` lets it draw. |
| `zoomBy(factor)` | Zooms about the centre (below 1 zooms in), stepped from the fov on screen like the wheel and keys, so every step shows. For zoom buttons. |
| `setNorth(rad)` / `heading()` | Sets the compass offset of the scene, or reads the heading the camera faces. |
| `setAutoRotate(on)` | Turns idle auto-rotate on or off. |
| `setLabel(label)` | Renames the canvas, e.g. for each scene. |
| `focus()` | Moves keyboard focus to the canvas without scrolling the page. |
| `isSettled()` | Whether every tile the view needs is in, as `tiles-settled` reports. |
| `project(yaw, pitch)` | Screen position of a direction in the last frame, in CSS px from the container's top left, plus `behind`. |
| `directionAtPixel(x, y)` | The direction under a container pixel. |
| `onRender(cb)` | Calls `cb(view)` after every frame and returns an unsubscribe. Use it to place overlays. |
| `requestRender()` | Asks for a frame. |
| `on(type, fn)` / `off(type, fn)` | Adds or removes an event listener. |
| `dispose()` | Stops everything and frees the WebGL context. |

## Events

| Event | Payload | When |
|---|---|---|
| `loading` | source id | A load started. |
| `ready` | the `CubeTileSource` | A load put the scene on screen. Read your own data from `source.meta`. |
| `scene-change` | source id | A load or `showPreview` changed what is on screen. |
| `tiles-settled` | none | Every tile the view needs is in. |
| `context-lost` | none | The WebGL context was lost. Nothing draws until it is restored. |
| `context-restored` | none | The context is back. The viewer reloads the scene by itself; a preview is not shown again. |
| `load-error` | `{ error, id }` | A load the viewer started by itself (the reload after a restore) failed. |

A base tile that can't be loaded rejects `load()` with a `BaseTileLoadError` carrying `sourceId`, `face`, `permanent` and `cause`. When `cause` is a `TileHttpError`, its `status` tells you, for example, a 401 apart from a 404.

## Preview format

`showPreview` takes a decoded equirectangular image as a `PreviewSource`: `{ width, height, patches }`. Each patch `{ x, y, w, h, image }` covers a rect of the `width × height` equirect, and its image is upright. A side may be at most `PREVIEW_MAX_PATCH_PX` (4096) or the GPU's texture limit. Neighbouring patches overlap by `PREVIEW_GUTTER_PX` (2) on each side to hide the seams. The viewer closes the patches' `ImageBitmap`s once they are uploaded, so a source can be shown only once. A later `load()` of the same id swaps the tiles in underneath it. The preview stays in front of tiles that are no sharper than itself, and is dropped at the next `tiles-settled`. For a replaced image, pass `replacesVersion`, the old source's `version`: the preview then stays on top of the old tiles until a source with another version loads.

## Accessibility

- The canvas is the interactive element. It gets `role="application"` and an `aria-label` (`interaction.label`, updated with `setLabel()`), set as attributes. It is focusable, and the arrow and `+`/`-` keys move the camera. Keys with Ctrl, Alt or Cmd are left to the browser, so page zoom and history shortcuts keep working.
- Don't put another `role="application"` around the canvas: nested application landmarks confuse screen readers.
- With `interaction.enabled: false` the canvas is `role="img"` instead and takes no input.
- With `transition.respectReducedMotion` on (the default), the scene change cuts instead of crossfading for visitors who prefer reduced motion. Auto-rotate is your call: it's off by default, and a host should leave it off for those visitors.
- Give the canvas a visible focus style, e.g. `#pano > canvas:focus-visible { outline: 2px solid; }`.
