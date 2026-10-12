import type { PanoViewerApi } from './api.js';
import { GLRenderer } from './render/gl-renderer.js';
import {
  viewProjection,
  projectDirInto,
  sameMatrix,
  unprojectNDC,
  type Mat4,
} from './render/projection.js';
import { TileLayer } from './tile-layer.js';
import { FACES } from './cube.js';
import { assertSource, type CubeTileSource, type ResolveHints } from './source.js';
import { warmTile, type TileNetwork } from './tile-fetch.js';
import {
  EquirectLayer,
  closePreviewSource,
  previewDrawLevel,
  type PreviewSource,
} from './equirect-layer.js';
import type { DrawItem } from './render/gl-renderer.js';
import { defaultTextureBudgetMB, isConstrainedDevice } from './texture-budget.js';
import { Controls } from './controls.js';
import { resolveViewerOptions } from './defaults.js';
import { Emitter } from './emitter.js';
import { report } from './report.js';
import { clamp } from './camera-math.js';
import { CameraRig, FRAME_MS, MAX_FRAME_DT_MS } from './camera-rig.js';
import type {
  ProjectedPoint,
  View,
  ViewerOptions,
  PanoViewerEvents,
  LoadOptions,
  PrefetchOptions,
  ResolvedViewerOptions,
  ShowPreviewOptions,
} from './types.js';
import { dirInto, isBehind, ndcToPixel, type Vec3 } from './project.js';

/** Decoded tiles uploaded per frame on a phone or tablet; elsewhere the layer's default. */
const CONSTRAINED_UPLOADS_PER_UPDATE = 4;

/**
 * Take a transition snapshot off the page, and free its backing store now
 * rather than at GC: Safari caps the memory all canvases may hold.
 */
function dropOverlay(el: HTMLCanvasElement): void {
  el.remove();
  el.width = 0;
  el.height = 0;
}

/** A load's crossfade, shared between it and the swap it waits on. */
interface Crossfade {
  ms: number;
  /** The snapshot of the old scene, put up at the swap. */
  snap?: HTMLCanvasElement | undefined;
}

/** A preview on screen, and how it relates to the tiles of its scene. */
interface Preview {
  layer: EquirectLayer;
  /** The scene it previews. */
  id: string;
  /**
   * The version of the tiles it replaces ('' for unversioned ones);
   * undefined for a new scene, where any source is the preview's own.
   */
  replaces: string | undefined;
  /**
   * True once its own tiles are on screen: it then sits among the tile
   * levels by resolution (see previewDrawLevel) and is disposed at the next
   * tiles-settled. False while it covers tiles that are not its own.
   */
  underlay: boolean;
}

/** A load to finish after a context restore. */
interface Reload {
  id: string;
  view: Partial<View> | undefined;
  /** Held from the first time round, so the reload costs no resolve. */
  source?: CubeTileSource;
  /** Emit ready and scene-change: false for the scene that was already on screen. */
  announce: boolean;
  /** Crossfade from the old scene at the swap (`LoadOptions.transition`). */
  crossfade?: Crossfade;
}

export class PanoViewer implements PanoViewerApi {
  private renderer: GLRenderer;
  private emitter = new Emitter<PanoViewerEvents>();
  // Undefined with `interaction.enabled: false`.
  private controls: Controls | undefined;
  private layer: TileLayer | undefined;
  // Layers still loading their base. Until a layer's base is resident it is not
  // assigned to `this.layer`, so without this set dispose() cannot reach it:
  // its `disposed` flag stays false, every guard inside it is dead code, and
  // its fetches keep running (and retrying, and uploading) against a renderer
  // whose WebGL context is already gone. A set, not a field, because load() can
  // legitimately be in flight more than once — a superseded load is still
  // holding a layer that has to be torn down.
  private pendingLayers = new Set<TileLayer>();
  // The source resolve of the load in flight, aborted when a newer load,
  // a preview or dispose() supersedes it.
  private resolveAbort: AbortController | undefined;
  // Every prefetch in flight, aborted by dispose().
  private prefetches = new Set<AbortController>();
  // The load in flight, with its source once resolved. A context loss cancels
  // it, and the restore loads it again.
  private request: Reload | undefined;
  // What a context loss cancelled, for the restore to load.
  private lostRequest: Reload | undefined;
  // The source whose tiles are on screen: what a context restore loads again.
  private scene: CubeTileSource | undefined;
  // Between webglcontextlost and webglcontextrestored: no frames are drawn.
  private contextLost = false;
  // The preview on screen (showPreview), if any.
  private preview: Preview | undefined;
  // The scheduled animation frame, or 0. A frame is requested only when
  // something changed (invalidate) and the loop keeps itself going only while
  // the camera is still moving or auto-rotate is turning, so an idle viewer
  // costs nothing between frames.
  private raf = 0;
  private dirty = false;
  // Time of the last frame drawn while the loop was running; undefined once it
  // stops, so the first frame after an idle spell steps one nominal frame.
  private lastFrameT: number | undefined;
  // Time of the last frame drawn at all. The first frame after a short idle
  // spell (a drag's frames, then its release) steps only the time since it,
  // so at 120 Hz a fling's first frame is not a 60 Hz frame's jump.
  private lastDrawT: number | undefined;
  // False while the container is scrolled out of view: no frames are drawn
  // and auto-rotate does not turn.
  private onScreen = true;
  private wasPending = false;
  // The camera and everything that moves it.
  private rig: CameraRig;
  // Every option with its default filled in, fixed at construction. north
  // and autoRotate.enabled change at runtime (setNorth, setAutoRotate), so
  // the live values are the rig's.
  private opts: ResolvedViewerOptions;
  private textureBudgetMB: number;
  // A phone or tablet (see isConstrainedDevice), read once at construction.
  private constrained: boolean;
  private resolveSource: ViewerOptions['resolveSource'];
  private network: TileNetwork;
  private loadToken = 0;
  private disposed = false;
  private renderCbs = new Set<(view: Readonly<View>) => void>();
  // What render callbacks are handed: a copy, so they cannot move the camera
  // by writing to it, reused so a frame allocates nothing.
  private frameView: View = { yaw: 0, pitch: 0, fov: 0 };
  // Render callbacks run on the next frame whatever the camera does: set by a
  // subscription, a resize, a scene change, a north change or requestRender().
  private notifyRender = true;
  // The view and view-projection matrix the render callbacks last ran for.
  // A frame drawn for a tile landing leaves both unchanged, and they are
  // skipped.
  private notifiedView: View = { yaw: 0, pitch: 0, fov: 0 };
  private notifiedViewProj: Mat4 = new Float32Array(16);
  private transitionOverlay: HTMLCanvasElement | undefined;
  private resizeObserver: ResizeObserver | undefined;
  // Matches only at the current device pixel ratio, so it fires when the
  // window moves to a display with another one. Re-armed each time.
  private pixelRatioQuery: MediaQueryList | undefined;
  private intersectionObserver: IntersectionObserver | undefined;
  // The view-projection matrix and forward vector of the frame last drawn,
  // rewritten in place each frame.
  private viewProj: Mat4 = new Float32Array(16);
  private fwd: Vec3 = { x: 0, y: 0, z: -1 };
  // Reused each frame when a preview and tiles are drawn together.
  private frameList: DrawItem[] = [];
  // Scratch for project(), which may run many times a frame.
  private projectScratch: Vec3 = { x: 0, y: 0, z: 0 };
  private ndcProjectScratch: Vec3 = { x: 0, y: 0, z: 0 };
  // A pointer in NDC, from toNdc().
  private ndcScratch = { x: 0, y: 0 };

  constructor(
    private container: HTMLElement,
    options: ViewerOptions = {},
  ) {
    const opts = resolveViewerOptions(options);
    this.opts = opts;
    const { camera, memory, rendering, interaction } = opts;
    // Only 'auto' scales with the display, and is held lower on a phone: a
    // caller who names a budget is naming an absolute one, and gets exactly
    // that. See texture-budget.ts for why the scale is linear in the pixel
    // ratio and capped. Read once,
    // here, so every panorama this viewer loads shares one budget — a window
    // dragged to a different-DPR monitor keeps the budget it was built with.
    this.constrained = isConstrainedDevice(
      window,
      typeof navigator === 'undefined' ? undefined : navigator,
    );
    this.textureBudgetMB =
      memory.textureBudgetMB === 'auto'
        ? defaultTextureBudgetMB(window.devicePixelRatio, rendering.maxPixelRatio, this.constrained)
        : memory.textureBudgetMB;
    this.resolveSource = options.resolveSource;
    this.network = {
      fetch: options.network?.fetch,
      requestInit: opts.network.requestInit,
      decode: options.network?.decode,
    };
    const rig = new CameraRig(
      camera,
      opts.autoRotate,
      options.initialView,
      this.invalidate,
      this.toNdc,
    );
    this.rig = rig;
    this.renderer = new GLRenderer(container, {
      antialias: rendering.antialias,
      maxPixelRatio: rendering.maxPixelRatio,
      maxPixels: rendering.maxPixels,
      anisotropy: rendering.anisotropy,
      background: rendering.background,
      onContextLost: this.onContextLost,
      onContextRestored: this.onContextRestored,
    });
    // The one layout read outside a resize: the size until the first
    // ResizeObserver callback reports it. Nothing is on screen yet, so the
    // first frame can wait for an animation frame.
    this.resizeTo(container.clientWidth, container.clientHeight, false);
    // project() works before the first frame too (chrome places itself as
    // soon as the viewer exists), so the camera it reads starts out current.
    viewProjection(rig.view, rig.aspect, camera.maxHorizontalFov, this.viewProj);
    dirInto(this.fwd, rig.view.yaw, rig.view.pitch);
    // The rig is the Controls' host, built once: rebuilding it on each load
    // would drop a drag that is in progress when a scene swaps in. Being a
    // private object, it keeps the input methods off the viewer's public
    // surface.
    if (interaction.enabled) this.controls = new Controls(this.renderer.canvas, rig, interaction);
    if (interaction.a11y) {
      // Attributes, not the role and ariaLabel properties: Firefox ESR does
      // not reflect those, and would leave the canvas unnamed. A viewer that
      // takes no input is a picture to assistive tech, not an application.
      this.renderer.canvas.setAttribute('role', interaction.enabled ? 'application' : 'img');
      this.setLabel(interaction.label);
    }
    // ResizeObserver sees the container itself resized by layout (flex/grid
    // reflow, a sidebar toggling, display:none → visible, splitter panes),
    // not just the browser window, so the canvas never keeps a stale size.
    // The window's resize event is only the fallback without it: listening
    // to both resized twice per window resize, once from the padding box
    // (clientWidth) and once from the content box (contentRect).
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(this.onObservedResize);
      this.resizeObserver.observe(container);
    } else {
      window.addEventListener('resize', this.onWindowResize);
    }
    if (typeof IntersectionObserver !== 'undefined') {
      this.intersectionObserver = new IntersectionObserver(this.onIntersect);
      this.intersectionObserver.observe(container);
    }
    // A pixel ratio change without a size change (the window dragged to
    // another display, some zooms) resizes nothing ResizeObserver sees.
    this.watchPixelRatio();
    // resizeTo() above has already asked for the first frame.
  }

  /** Listen for `type` (see `PanoViewerEvents`); returns a function that removes the listener. */
  on<K extends keyof PanoViewerEvents>(
    type: K,
    fn: (payload: PanoViewerEvents[K]) => void,
  ): () => void {
    return this.emitter.on(type, fn);
  }

  /** Remove a listener added with `on()`. */
  off<K extends keyof PanoViewerEvents>(type: K, fn: (payload: PanoViewerEvents[K]) => void): void {
    this.emitter.off(type, fn);
  }

  /**
   * Mark the frame stale and ask for one animation frame to redraw it, unless
   * one is already coming or the viewer is off screen (it redraws on return).
   */
  private invalidate = (): void => {
    this.dirty = true;
    if (this.raf === 0 && this.onScreen && !this.disposed && !this.contextLost) {
      this.raf = requestAnimationFrame(this.frame);
    }
  };

  /** Ask for a frame, with the render callbacks run on it. */
  requestRender(): void {
    this.notifyRender = true;
    this.invalidate();
  }

  /**
   * Call `cb` after each frame that changes where things are on screen: the
   * camera moved, the viewer was resized, a scene swapped in or north was
   * set. Also on the next frame after subscribing or a `requestRender()`. A
   * frame drawn only because tiles landed does not call it. The view it gets
   * is a read-only copy, rewritten in place each frame: read it during the
   * call, don't keep it.
   */
  onRender(cb: (view: Readonly<View>) => void): () => void {
    this.renderCbs.add(cb);
    this.requestRender();
    return () => this.renderCbs.delete(cb);
  }

  /**
   * Load a source, or the id of one (resolved through `resolveSource`),
   * swapping it in once its low-resolution base is resident. Resolves true
   * when it took effect and false when a newer load, a preview, cancelLoad()
   * or dispose() superseded it; rejects only for a load that is still
   * current, including a source that fails to resolve or is malformed. `options.view` is applied
   * at the swap, with no easing from the old camera.
   *
   * With `options.transition`, the new scene crossfades in over a snapshot of
   * the old one, taken at the swap, for `transition.durationMs`: the old scene
   * stays live until the new one is ready. The promise then settles once the
   * fade is over.
   *
   * WebGL context loss: a load in flight when the context is lost resolves
   * false, and so does one started while it is lost, which waits (its base
   * tiles cannot be uploaded) until the context is restored or the viewer is
   * disposed. Either way the viewer loads that source itself once the context
   * is back, with the same view, and emits `ready` and `scene-change` for it;
   * if that reload fails it emits `load-error` instead.
   */
  load(source: CubeTileSource | string, options: LoadOptions = {}): Promise<boolean> {
    return options.transition
      ? this.crossfadeTo(source, options.view)
      : this.start(source, options.view);
  }

  private async start(
    source: CubeTileSource | string,
    view: Partial<View> | undefined,
    crossfade?: Crossfade,
  ): Promise<boolean> {
    const token = this.supersede();
    const stale = () => this.disposed || token !== this.loadToken;
    const id = typeof source === 'string' ? source : source.id;
    const request: Reload = { id, view, announce: true };
    if (typeof source !== 'string') request.source = source;
    if (crossfade) request.crossfade = crossfade;
    this.request = request;
    try {
      this.emitter.emit('loading', { id });
      if (stale()) return false;

      let resolved: CubeTileSource;
      if (typeof source === 'string') {
        const abort = new AbortController();
        this.resolveAbort = abort;
        try {
          resolved = await this.resolve(source, abort.signal);
          if (stale()) return false;
        } catch (err) {
          // An aborted or failed resolve for a load nobody is waiting on any more.
          if (stale()) return false;
          throw err;
        } finally {
          if (this.resolveAbort === abort) this.resolveAbort = undefined;
        }
      } else {
        resolved = source;
      }
      assertSource(resolved);
      request.source = resolved;
      return await this.swapIn(token, { ...request, source: resolved });
    } finally {
      if (this.request === request) this.request = undefined;
    }
  }

  /**
   * Cancel the load or transition in flight, if any: its pending `load()`
   * resolves false, its fetches stop, and the scene on screen stays as it
   * is, camera included. A crossfade still fading is cut short. A load that
   * a context loss is holding for the restore is dropped too.
   *
   * After a context restore the scene's tiles are being loaded again: that
   * reload is left alone, and cancelling a load the restore was finishing
   * in its place loads the scene back instead of leaving the stage blank.
   */
  cancelLoad(): void {
    if (this.disposed) return;
    // Only a restore's reload of the scene on screen goes unannounced.
    if (this.request && !this.request.announce) return;
    this.supersede();
    this.lostRequest = undefined;
    const scene = this.scene;
    if (!this.layer && !this.contextLost && scene) {
      this.reloadInBackground({ id: scene.id, view: undefined, source: scene, announce: false });
    }
  }

  private resolve(id: string, signal: AbortSignal, hints?: ResolveHints): Promise<CubeTileSource> {
    const resolver = this.resolveSource;
    if (!resolver) {
      return Promise.reject(
        new TypeError(`tile source "${id}": an id needs the resolveSource option`),
      );
    }
    return resolver(id, signal, hints);
  }

  /**
   * Build a layer for `req`'s source, wait for its base, then put it on
   * screen in place of whatever is there. False when superseded.
   */
  private async swapIn(token: number, req: Reload & { source: CubeTileSource }): Promise<boolean> {
    const stale = () => this.disposed || token !== this.loadToken;
    const { source } = req;
    const layer = new TileLayer(this.renderer, source, this.invalidate, {
      textureBudgetMB: this.textureBudgetMB,
      maxConcurrent: this.opts.network.maxConcurrent,
      minResidentTiles: this.opts.memory.minResidentTiles,
      lodBias: this.opts.rendering.lodBias,
      retry: this.opts.network.retry,
      network: this.network,
      // A phone's GPU takes longer over each upload than the frame clock shows.
      ...(this.constrained && { maxUploadsPerUpdate: CONSTRAINED_UPLOADS_PER_UPDATE }),
    });
    layer.setPaused(!this.onScreen);

    // Blocking: the panorama is not loaded until its low-resolution base is.
    // The six level-0 tiles are one per cube face, so together they are the
    // whole panorama at its coarsest — with them resident every direction has a
    // texture, and a high-resolution tile that fails or is missing degrades to
    // soft detail rather than to a black patch. A partial load would ship that
    // guarantee as a maybe, so a base that cannot be fetched is fatal here.
    this.pendingLayers.add(layer);
    try {
      // The base is requested first, then the tiles the arrival view needs,
      // so the detail starts loading alongside the base instead of after it.
      // The layer is not drawn until it swaps in, so nothing shows early.
      const base = layer.loadBase();
      this.prime(layer, req.view);
      await base;
    } catch (err) {
      this.pendingLayers.delete(layer);
      layer.dispose();
      // A superseded or disposed load is not this caller's failure to hear
      // about — the load that replaced it owns the outcome.
      if (stale()) return false;
      throw err;
    }
    this.pendingLayers.delete(layer);

    // Disposed under this load: dispose() has already torn the layer down, so
    // this resolves quietly. Rejecting would be defensible too, but every other
    // disposed/superseded exit above returns, and a caller that disposed the
    // viewer is not waiting to be told the load it abandoned did not finish.
    if (stale()) {
      layer.dispose();
      return false;
    }

    // The outgoing panorama is only torn down now that the incoming one can
    // actually be drawn. Disposing it before the base was resident would blank
    // the viewer for the length of the fetch, and would leave it blank for good
    // if the fetch failed; this way a rejected load leaves exactly what was on
    // screen before it was called.
    if (req.crossfade) this.raiseSnapshot(req.crossfade);
    this.layer?.dispose();
    this.layer = layer;
    this.scene = source;
    this.rig.cutTo(req.view);
    const preview = this.preview;
    if (preview && preview.id === source.id) {
      // Replacing an image keeps the id, so the source can still be the old
      // image's until the new tiles are written. Those tiles are not the
      // preview's: it stays on top of them and outlives their tiles-settled.
      const own = preview.replaces === undefined || (source.version ?? '') !== preview.replaces;
      preview.underlay = own;
      preview.layer.setLevel(
        own
          ? previewDrawLevel(preview.layer.width, source.tileSize, source.maxLevel)
          : source.maxLevel + 1,
      );
    } else {
      this.disposePreview();
    }
    this.wasPending = true;
    // Hosts place their overlays for the new scene on its first frame.
    this.requestRender();
    if (!req.announce) return true;
    this.emitter.emit('ready', { id: source.id, source });
    // A ready listener may have started another load or disposed the viewer;
    // the scene is then not changing to this one.
    if (!stale()) this.emitter.emit('scene-change', { id: source.id, kind: 'tiles' });
    return true;
  }

  // Every GL object is gone: the tiles, the preview's patches, the frame on
  // the canvas. A load in flight cannot finish either, since its uploads
  // would fail, so it is cancelled (resolving false) and loaded again once the
  // context is back, as is the scene on screen.
  private onContextLost = (): void => {
    if (this.disposed) return;
    this.contextLost = true;
    if (this.request) this.lostRequest = this.request;
    this.supersede();
    // Its fetches would only decode tiles nothing can upload.
    this.layer?.dispose();
    this.layer = undefined;
    // Its bitmaps were closed once uploaded, so it cannot be shown again.
    this.disposePreview();
    this.wasPending = false;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.lastFrameT = undefined;
    this.emitter.emit('context-lost', undefined);
  };

  private onContextRestored = (): void => {
    if (this.disposed) return;
    this.contextLost = false;
    // The newest of: a load started while the context was lost, the load the
    // loss cancelled, the scene that was on screen. The camera stays where it
    // is, so the scene comes back as it was left.
    const scene = this.scene;
    const next: Reload | undefined =
      this.request ??
      this.lostRequest ??
      (scene && { id: scene.id, view: undefined, source: scene, announce: false });
    this.lostRequest = undefined;
    this.disposePreview();
    this.requestRender();
    if (next) this.reloadInBackground(next);
    this.emitter.emit('context-restored', undefined);
  };

  /** reload() with nobody awaiting it: a failure reaches the host as `load-error`. */
  private reloadInBackground(req: Reload): void {
    this.reload(req).catch((error: unknown) => {
      this.emitter.emit('load-error', { id: req.id, error });
    });
  }

  private async reload(req: Reload): Promise<boolean> {
    const { source } = req;
    if (!source) return this.start(req.id, req.view);
    const token = this.supersede();
    // No crossfade: the load that asked for one has already given up.
    const request: Reload = { id: req.id, view: req.view, source, announce: req.announce };
    this.request = request;
    try {
      return await this.swapIn(token, { ...request, source });
    } finally {
      if (this.request === request) this.request = undefined;
    }
  }

  /**
   * Queue the tiles `layer` needs for the camera it will arrive with: the
   * current target, with `view`'s axes applied as the swap will apply them.
   */
  private prime(layer: TileLayer, view: Partial<View> | undefined): void {
    const rig = this.rig;
    const arrival = rig.arrival(view);
    layer.update(
      viewProjection(arrival, rig.aspect, this.opts.camera.maxHorizontalFov),
      rig.effectiveVFovDeg(arrival.fov),
      dirInto({ x: 0, y: 0, z: 0 }, arrival.yaw, arrival.pitch),
      this.rasterHeight(),
    );
  }

  /**
   * The framebuffer's height in device pixels: what selectLevel (lod.ts)
   * compares texel density against. Not the CSS height, which on a DPR > 1
   * display would pick a level coarser than the screen can show.
   */
  private rasterHeight(): number {
    return this.renderer.canvas.height || 1;
  }

  /**
   * Cancel whatever load is in flight: bump the token so it resolves false,
   * stop its fetches so they don't compete with the new scene, and drop a
   * transition snapshot that would otherwise sit over the new scene until the
   * superseded load gave up. Returns the new token.
   */
  private supersede(): number {
    const token = ++this.loadToken;
    this.request = undefined;
    this.resolveAbort?.abort();
    this.resolveAbort = undefined;
    for (const pending of this.pendingLayers) pending.dispose();
    this.pendingLayers.clear();
    if (this.transitionOverlay) dropOverlay(this.transitionOverlay);
    this.transitionOverlay = undefined;
    return token;
  }

  /**
   * Show a local decode of the scene `id` now, in place of whatever is on
   * screen. The camera stays where it is, or cuts to `options.view`.
   *
   * A later `load()` of a source with that id swaps the tiles in under it:
   * once they are on screen the preview paints over the tile levels no
   * sharper than itself and under the sharper ones (see `previewDrawLevel`),
   * and is disposed at the next `tiles-settled`. On a replace, `id` already
   * has tiles from the old image and the new version is not known until the
   * new tiles exist, so pass `options.replacesVersion`, the old source's
   * `version` (`''` for one without). A `load()` that gets a source with that
   * version leaves the preview on top of the old tiles and keeps it past
   * their `tiles-settled`; any other version is the preview's own. Without
   * `replacesVersion` (a new scene), any source for `id` is its own.
   *
   * Ownership: the patches' ImageBitmaps are closed as soon as they are on the
   * GPU (or straight away if the viewer is disposed or the source is
   * rejected), so a `PreviewSource` can be shown once. To show it again,
   * decode it again from the stored image.
   *
   * Any `load()` in flight is cancelled, including one for `id`: it
   * resolves without swapping anything in. Call `load(id)` again after
   * this to get the tiles.
   */
  showPreview(id: string, source: PreviewSource, options: ShowPreviewOptions = {}): void {
    if (this.disposed) {
      closePreviewSource(source);
      return;
    }
    // Built first: a source that throws leaves the viewer exactly as it was.
    const layer = new EquirectLayer(this.renderer, source);
    this.supersede();
    this.disposePreview();
    this.preview = { layer, id, replaces: options.replacesVersion, underlay: false };
    this.layer?.dispose();
    this.layer = undefined;
    this.scene = undefined;
    this.wasPending = false;
    this.rig.cutTo(options.view);
    this.requestRender();
    this.emitter.emit('scene-change', { id, kind: 'preview' });
  }

  private disposePreview(): void {
    this.preview?.layer.dispose();
    this.preview = undefined;
  }

  // Painter's order is applied by the renderer, so the order here is free.
  private drawList(): DrawItem[] {
    const list = this.frameList;
    list.length = 0;
    if (!this.preview) return this.layer ? this.layer.drawList() : list;
    for (const item of this.preview.layer.drawList()) list.push(item);
    if (this.layer) for (const item of this.layer.drawList()) list.push(item);
    return list;
  }

  /** Set the compass north offset (radians) for the currently loaded scene. */
  setNorth(radians: number): void {
    this.rig.setNorth(radians);
    this.requestRender();
  }

  /** Current compass heading (radians): north relative to the rendered yaw. */
  heading(): number {
    return this.rig.heading();
  }

  /** Enable or disable idle auto-rotate at runtime; interaction still pauses it. */
  setAutoRotate(enabled: boolean): void {
    this.rig.setAutoRotate(enabled);
  }

  /** A pointer in client coordinates as NDC (−1..1, y up), in a reused object. */
  private toNdc = (clientX: number, clientY: number): { x: number; y: number } => {
    // Mapped through the canvas's on-screen rect: page scroll moves it
    // without a resize, and a CSS transform scales it without changing the
    // cached layout size.
    const rect = this.renderer.canvas.getBoundingClientRect();
    const out = this.ndcScratch;
    out.x = ((clientX - rect.left) / (rect.width || 1)) * 2 - 1;
    out.y = -(((clientY - rect.top) / (rect.height || 1)) * 2 - 1);
    return out;
  };

  setView(view: Partial<View>): void {
    this.rig.setView(view);
  }

  /**
   * Zoom by `factor` about the centre (below 1 zooms in), easing like
   * setView. Stepped from the fov on screen, like the viewer's own wheel and
   * keys, so every step shows: for zoom buttons, rather than scaling
   * `getView().fov`, which can sit above what a wide viewport draws.
   */
  zoomBy(factor: number): void {
    this.rig.zoomBy(factor);
  }

  /**
   * Give the viewer keyboard focus, so its arrow and zoom keys work. A host
   * calls this when chrome it put over the viewer goes away while focused,
   * so focus lands here rather than on the page. The page does not scroll.
   */
  focus(): void {
    this.renderer.canvas.focus({ preventScroll: true });
  }

  /**
   * Set the canvas's accessible name (`interaction.label`), e.g. to the scene
   * on screen. Does nothing with `interaction.a11y` off.
   */
  setLabel(label: string): void {
    if (this.opts.interaction.a11y) this.renderer.canvas.setAttribute('aria-label', label);
  }

  /** The camera being moved to, with yaw in (−π, π]. */
  getView(): View {
    return this.rig.getView();
  }

  private onWindowResize = () => {
    this.resizeTo(this.container.clientWidth, this.container.clientHeight);
  };

  private watchPixelRatio(): void {
    this.pixelRatioQuery?.removeEventListener('change', this.onPixelRatioChange);
    this.pixelRatioQuery = undefined;
    if (this.disposed || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    if (typeof query?.addEventListener !== 'function') return;
    query.addEventListener('change', this.onPixelRatioChange);
    this.pixelRatioQuery = query;
  }

  // The query named the old ratio and has stopped matching: watch the new
  // one, and size the backbuffer for it.
  private onPixelRatioChange = (): void => {
    this.watchPixelRatio();
    this.resizeTo(this.rig.cssW, this.rig.cssH);
  };

  // The observer reports the new size, so this costs no layout read.
  private onObservedResize = (entries: ResizeObserverEntry[]) => {
    const rect = entries[entries.length - 1]?.contentRect;
    if (rect) this.resizeTo(rect.width, rect.height);
    else this.onWindowResize();
  };

  /**
   * Size the canvas for a `width` × `height` container. Nothing happens when
   * neither that nor the backbuffer changed. Otherwise the resize has cleared
   * the drawing buffer, and with `drawNow` the frame is drawn again here, in
   * the same task: a ResizeObserver callback runs after the frame's animation
   * callbacks, so waiting for the next one would show the cleared canvas.
   */
  private resizeTo(width: number, height: number, drawNow = true): void {
    const rig = this.rig;
    rig.setViewport(width, height);
    if (!this.renderer.resize(rig.cssW, rig.cssH)) return;
    // Overlays are placed in CSS pixels, which moved even if the matrix did not.
    this.notifyRender = true;
    if (drawNow && this.onScreen && !this.disposed && !this.contextLost) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
      // The last frame's time when the loop is running, so this draws the
      // camera where it is rather than stepping it; the loop goes on from it.
      this.frame(this.lastFrameT ?? performance.now());
    } else {
      this.invalidate();
    }
  }

  // Off screen, no frames are drawn and auto-rotate holds still; coming back
  // starts its clock afresh rather than turning for the time spent away.
  private onIntersect = (entries: IntersectionObserverEntry[]) => {
    const entry = entries[entries.length - 1];
    if (!entry || entry.isIntersecting === this.onScreen) return;
    this.onScreen = entry.isIntersecting;
    this.rig.restartAutoRotateClock();
    // No new tile requests while nobody can see them; the ones in flight finish.
    this.layer?.setPaused(!this.onScreen);
    for (const pending of this.pendingLayers) pending.setPaused(!this.onScreen);
    if (this.onScreen) {
      this.invalidate();
    } else {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
      this.lastFrameT = undefined;
    }
  };

  private frame = (t: number) => {
    this.raf = 0;
    if (this.disposed) return;
    const dt =
      this.lastFrameT === undefined
        ? clamp(t - (this.lastDrawT ?? -Infinity), 0, FRAME_MS)
        : clamp(t - this.lastFrameT, 0, MAX_FRAME_DT_MS);
    this.lastFrameT = t;
    this.lastDrawT = t;

    const rig = this.rig;
    this.dirty = rig.step(t, dt);
    const view = rig.view;

    const vfovDeg = rig.effectiveVFovDeg(view.fov);
    viewProjection(view, rig.aspect, this.opts.camera.maxHorizontalFov, this.viewProj);
    this.renderer.setCamera(this.viewProj);
    dirInto(this.fwd, view.yaw, view.pitch);
    this.layer?.update(this.viewProj, vfovDeg, this.fwd, this.rasterHeight());

    // Queued tiles count as pending: the queue outlasts a frame only while
    // every request slot is busy, and settling then would drop the preview
    // before its tiles exist. A tile that fails (for good, or until its
    // cooldown ends) does not count, so failed tiles can still end the
    // preview, leaving coarser tiles in their place.
    const pending = this.layer?.hasPending() ?? false;
    const tilesSettled = this.wasPending && !pending;
    if (tilesSettled && this.preview?.underlay) this.disposePreview();
    this.wasPending = pending;

    // Draw before anything outside the viewer runs: a listener that throws
    // or disposes the viewer must not cost this frame its render.
    this.renderer.render(this.drawList());
    if (tilesSettled) {
      this.emitter.emit('tiles-settled', undefined);
      if (this.disposed) return;
    }
    // Only when something on screen moved: a frame drawn because a tile
    // landed would have every callback re-place its overlays where they are.
    const last = this.notifiedView;
    const moved =
      this.notifyRender ||
      view.yaw !== last.yaw ||
      view.pitch !== last.pitch ||
      view.fov !== last.fov ||
      !sameMatrix(this.viewProj, this.notifiedViewProj);
    if (moved && this.renderCbs.size > 0) {
      this.notifyRender = false;
      this.notifiedViewProj.set(this.viewProj);
      last.yaw = view.yaw;
      last.pitch = view.pitch;
      last.fov = view.fov;
      const out = this.frameView;
      for (const cb of this.renderCbs) {
        out.yaw = view.yaw;
        out.pitch = view.pitch;
        out.fov = view.fov;
        try {
          cb(out);
        } catch (err) {
          report(err);
        }
        if (this.disposed) return;
      }
    }

    // Keep going only while there is motion to draw; anything else that
    // needs a frame asks for one through invalidate().
    if (this.dirty || rig.autoRotating()) {
      this.invalidate();
    } else {
      this.lastFrameT = undefined;
    }
  };

  /**
   * Whether `tiles-settled` holds right now: the frame that settles has run
   * and the scene on screen has no tiles pending. A host that subscribes to
   * `tiles-settled` late can check this instead of waiting for the next one.
   * Like the event, it says nothing about the camera: a moving or
   * auto-rotating view is settled whenever its tiles are in. A load still in
   * flight does not count until it swaps in.
   */
  isSettled(): boolean {
    return !this.contextLost && !this.wasPending && !(this.layer?.hasPending() ?? false);
  }

  /**
   * Where the direction (yaw, pitch) is on screen in the frame last drawn, in
   * CSS pixels from the container's top left. Reads no layout, so a render
   * callback can call it between style writes. Written into `out` when given,
   * so placing many markers a frame allocates nothing; otherwise each call
   * returns a new object.
   */
  project(
    yaw: number,
    pitch: number,
    out: ProjectedPoint = { x: 0, y: 0, behind: false },
  ): ProjectedPoint {
    const d = dirInto(this.projectScratch, yaw, pitch);
    out.behind = isBehind(d, this.fwd);
    const ndc = projectDirInto(this.ndcProjectScratch, d, this.viewProj);
    return ndcToPixel(ndc.x, ndc.y, this.rig.cssW, this.rig.cssH, out);
  }

  directionAtPixel(px: number, py: number): { yaw: number; pitch: number } {
    const ndcX = (px / this.rig.cssW) * 2 - 1;
    const ndcY = -((py / this.rig.cssH) * 2 - 1);
    const v = unprojectNDC(ndcX, ndcY, this.viewProj);
    return { yaw: Math.atan2(v.x, -v.z), pitch: Math.asin(clamp(v.y, -1, 1)) };
  }

  /**
   * Warm the HTTP cache for a scene the visitor may open next: its source
   * (resolved at low priority when given an id) and the six level-0 tiles
   * that `load` blocks on, fetched at low priority through the same request
   * path as a load, with the bodies read and dropped. Best effort: it never
   * rejects, whether the source is missing, the network fails, `signal`
   * aborts or the viewer is disposed. Whether to prefetch at all (save-data,
   * a slow connection) is the host's call.
   */
  async prefetch(source: CubeTileSource | string, options: PrefetchOptions = {}): Promise<void> {
    const { signal } = options;
    if (this.disposed || signal?.aborted) return;
    const abort = new AbortController();
    const cancel = () => abort.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    this.prefetches.add(abort);
    try {
      const src =
        typeof source === 'string'
          ? await this.resolve(source, abort.signal, { priority: 'low' })
          : source;
      if (abort.signal.aborted) return;
      assertSource(src);
      await Promise.allSettled(
        FACES.map((face) =>
          warmTile(src, { face, level: 0, x: 0, y: 0 }, abort.signal, this.network),
        ),
      );
    } catch {
      // Best effort: the real load reports its own errors.
    } finally {
      signal?.removeEventListener('abort', cancel);
      this.prefetches.delete(abort);
    }
  }

  /**
   * Put a copy of the frame on screen over the canvas, for a transition to
   * fade out. Taken at the swap, while the old scene is still drawable, so
   * the old scene stays live and interactive for the whole load and the
   * snapshot is up only for the fade.
   */
  private raiseSnapshot(fade: Crossfade): void {
    // Only snapshot when there is something to draw; snapshotting an empty
    // draw list would crossfade from a black frame.
    const drawList = this.drawList();
    if (drawList.length === 0) return;
    try {
      // A copy of the frame, made on the GPU; null while the context is lost.
      const snap = this.renderer.snapshot(drawList) ?? undefined;
      if (!snap) return;
      snap.style.cssText =
        'position:absolute;inset:0;width:100%;height:100%;' +
        'pointer-events:none;transition:opacity ' +
        fade.ms +
        'ms ease;opacity:1;z-index:5;';
      this.container.appendChild(snap);
      this.transitionOverlay = snap;
      fade.snap = snap;
    } catch {
      // No snapshot: the new scene cuts in instead of crossfading.
    }
  }

  /** A load with a crossfade: see `load()`. */
  private async crossfadeTo(
    source: CubeTileSource | string,
    view: Partial<View> | undefined,
  ): Promise<boolean> {
    if (this.disposed) return false;
    const { durationMs, respectReducedMotion } = this.opts.transition;
    const reduce =
      respectReducedMotion && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const fade: Crossfade = { ms: reduce ? 0 : durationMs };
    try {
      // Superseded: the newer call owns the camera, and no snapshot went up.
      const tookEffect = await this.start(source, view, fade);
      const snap = fade.snap;
      if (snap && tookEffect && this.transitionOverlay === snap) {
        await new Promise((r) => requestAnimationFrame(() => r(null)));
        snap.style.opacity = '0';
        await new Promise((r) => setTimeout(r, fade.ms));
      }
      return tookEffect;
    } finally {
      // Always tear the overlay down — even if the load rejected — but don't
      // clobber an overlay a newer transition may have installed.
      const snap = fade.snap;
      if (snap) {
        dropOverlay(snap);
        if (this.transitionOverlay === snap) this.transitionOverlay = undefined;
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.rig.dispose();
    window.removeEventListener('resize', this.onWindowResize);
    this.pixelRatioQuery?.removeEventListener('change', this.onPixelRatioChange);
    this.pixelRatioQuery = undefined;
    this.resizeObserver?.disconnect();
    this.intersectionObserver?.disconnect();
    this.controls?.dispose();
    // Pending layers first: they are the ones with fetches still in flight, and
    // they must stop before the renderer's GL context is destroyed below.
    this.supersede();
    for (const prefetch of this.prefetches) prefetch.abort();
    this.prefetches.clear();
    this.layer?.dispose();
    this.disposePreview();
    this.renderCbs.clear();
    this.renderer.dispose();
  }
}
