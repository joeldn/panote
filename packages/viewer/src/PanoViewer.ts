import { manifestUrl, parseManifest, type Manifest } from '@panote/core';
import { GLRenderer } from './render/gl-renderer.js';
import {
  viewProjection,
  effectiveVFovDeg,
  projectDir,
  unprojectNDC,
  type Mat4,
} from './render/projection.js';
import { TileLayer } from './tile-layer.js';
import {
  EquirectLayer,
  closePreviewSource,
  previewDrawLevel,
  type PreviewSource,
} from './equirect-layer.js';
import type { DrawItem } from './render/gl-renderer.js';
import { defaultTextureBudgetMB } from './texture-budget.js';
import { Controls } from './controls.js';
import type { ControlHost } from './controls.js';
import { VIEWER_DEFAULTS } from './defaults.js';
import { Emitter } from './emitter.js';
import {
  clampPitch,
  clampFov,
  damp,
  anglePerPixel,
  zoomAnchorDelta,
  compassHeading,
  normalizeAngle,
} from './camera-math.js';
import type { View, ViewerOptions, PanoViewerEvents, LoadOptions } from './types.js';
import { dirInto, isBehind, ndcToPixel, type Vec3 } from './project.js';

const TWO_PI = Math.PI * 2;
const DEG2RAD = Math.PI / 180;
// damping and momentumFriction are per 60 Hz frame; motion is scaled to the
// real frame time so it feels the same at 30, 60 and 120 Hz.
const FRAME_MS = 1000 / 60;
// A stalled or backgrounded tab must not spend its whole absence as one jump on resume.
const MAX_FRAME_DT_MS = 100;
// Momentum below this (rad/ms) is stopped: 1e-5 rad per 60 Hz frame.
const MOMENTUM_EPS = 1e-5 / FRAME_MS;

/** `yaw` less its whole turns: the same rendered angle, kept within ±2π. */
function unwound(yaw: number): number {
  return yaw - Math.trunc(yaw / TWO_PI) * TWO_PI;
}

/** Hand a listener's exception to the host's error reporting without unwinding the frame. */
function report(err: unknown): void {
  if (typeof reportError === 'function') reportError(err);
  else console.error(err);
}

/**
 * Take a transition snapshot off the page, and free its backing store now
 * rather than at GC: Safari caps the memory all canvases may hold.
 */
function dropOverlay(el: HTMLCanvasElement): void {
  el.remove();
  el.width = 0;
  el.height = 0;
}

/** A load to finish after a context restore. */
interface Reload {
  pano: string;
  view: Partial<View> | undefined;
  /** Held from the first time round, so the reload costs no manifest fetch. */
  manifest?: Manifest;
  /** Emit ready and scene-change: false for the scene that was already on screen. */
  announce: boolean;
}

export class PanoViewer {
  private renderer: GLRenderer;
  private emitter = new Emitter<PanoViewerEvents>();
  private controls: Controls;
  private layer: TileLayer | undefined;
  // Layers still loading their base. Until a layer's base is resident it is not
  // assigned to `this.layer`, so without this set dispose() cannot reach it:
  // its `disposed` flag stays false, every guard inside it is dead code, and
  // its fetches keep running (and retrying, and uploading) against a renderer
  // whose WebGL context is already gone. A set, not a field, because load() can
  // legitimately be in flight more than once — a superseded load is still
  // holding a layer that has to be torn down.
  private pendingLayers = new Set<TileLayer>();
  // The manifest fetch of the load in flight, aborted when a newer load,
  // a preview or dispose() supersedes it.
  private manifestAbort: AbortController | undefined;
  // The load in flight, with its manifest once fetched. A context loss cancels
  // it, and the restore loads it again.
  private request: Reload | undefined;
  // What a context loss cancelled, for the restore to load.
  private lostRequest: Reload | undefined;
  // The pano whose tiles are on screen, and its manifest: what a context
  // restore loads again.
  private scene: { pano: string; manifest: Manifest } | undefined;
  // Between webglcontextlost and webglcontextrestored: no frames are drawn.
  private contextLost = false;
  private preview: EquirectLayer | undefined;
  private previewPano: string | undefined;
  // The version of the tiles the preview replaces ('' for unversioned ones);
  // undefined for a new pano, where any manifest is the preview's own.
  private previewReplaces: string | undefined;
  // True once the preview's own tiles are on screen: it then sits among the
  // tile levels by resolution (see previewDrawLevel) and is disposed at the
  // next tiles-settled. False while it covers tiles that are not its own.
  private previewUnderlay = false;
  // The scheduled animation frame, or 0. A frame is requested only when
  // something changed (invalidate) and the loop keeps itself going only while
  // the camera is still moving or auto-rotate is turning, so an idle viewer
  // costs nothing between frames.
  private raf = 0;
  private dirty = false;
  // Time of the last frame drawn while the loop was running; undefined once it
  // stops, so the first frame after an idle spell steps one nominal frame.
  private lastFrameT: number | undefined;
  // False while the container is scrolled out of view: no frames are drawn
  // and auto-rotate does not turn.
  private onScreen = true;
  private wasPending = false;
  private view: View;
  private target: View;
  // north/autoRotate* are runtime-mutable (setNorth/setAutoRotate), so they
  // live in their own fields below rather than this fixed-at-construction set.
  private opts: Required<
    Omit<
      ViewerOptions,
      'initialView' | 'north' | 'autoRotate' | 'autoRotateSpeed' | 'autoRotateIdleMs' | 'wheel'
    >
  >;
  private loadToken = 0;
  private disposed = false;
  // Release inertia, in rad/ms.
  private momentum = { yaw: 0, pitch: 0 };
  private renderCbs = new Set<(view: Readonly<View>) => void>();
  // What render callbacks are handed: a copy, so they cannot move the camera
  // by writing to it, reused so a frame allocates nothing.
  private frameView: View = { yaw: 0, pitch: 0, fov: 0 };
  private transitionOverlay: HTMLCanvasElement | undefined;
  private resizeObserver: ResizeObserver | undefined;
  // Matches only at the current device pixel ratio, so it fires when the
  // window moves to a display with another one. Re-armed each time.
  private pixelRatioQuery: MediaQueryList | undefined;
  private intersectionObserver: IntersectionObserver | undefined;
  // The container's CSS size, kept by resize events so that no frame, input
  // event or project() call has to read layout.
  private cssW = 1;
  private cssH = 1;
  private aspect = 1;
  // The view-projection matrix and forward vector of the frame last drawn,
  // rewritten in place each frame.
  private viewProj: Mat4 = new Float32Array(16);
  private fwd: Vec3 = { x: 0, y: 0, z: -1 };
  // Reused each frame when a preview and tiles are drawn together.
  private frameList: DrawItem[] = [];
  // Scratch for project(), which may run many times a frame.
  private projectScratch: Vec3 = { x: 0, y: 0, z: 0 };
  private north: number;
  private autoRotateEnabled: boolean;
  private autoRotateSpeed: number;
  private autoRotateIdleMs: number;
  // Whether auto-rotate is actually turning this frame — false while a
  // recent interaction's idle timer hasn't elapsed yet.
  private autoRotateActive: boolean;
  private autoRotateResumeTimer: ReturnType<typeof setTimeout> | undefined;
  // Last frame auto-rotate advanced yaw on; undefined whenever it isn't
  // running, so the frame it (re)starts on applies zero elapsed time.
  private autoRotateLastFrame: number | undefined;

  constructor(
    private container: HTMLElement,
    options: ViewerOptions = {},
  ) {
    const d = VIEWER_DEFAULTS;
    const maxPixelRatio = options.maxPixelRatio ?? d.maxPixelRatio;
    this.opts = {
      baseUrl: options.baseUrl ?? d.baseUrl,
      minFov: options.minFov ?? d.minFov,
      maxFov: options.maxFov ?? d.maxFov,
      maxHorizontalFov: options.maxHorizontalFov ?? d.maxHorizontalFov,
      // Only the default scales with the display: a caller who names a budget
      // is naming an absolute one, and gets exactly that. See texture-budget.ts
      // for why the scale is linear in the pixel ratio and capped. Read once,
      // here, so every panorama this viewer loads shares one budget — a window
      // dragged to a different-DPR monitor keeps the budget it was built with.
      textureBudgetMB:
        options.textureBudgetMB ?? defaultTextureBudgetMB(window.devicePixelRatio, maxPixelRatio),
      damping: options.damping ?? d.damping,
      momentumFriction: options.momentumFriction ?? d.momentumFriction,
      maxPixelRatio,
      maxPixels: options.maxPixels ?? d.maxPixels,
      antialias: options.antialias ?? d.antialias,
      maxConcurrent: options.maxConcurrent ?? d.maxConcurrent,
      transitionMs: options.transitionMs ?? d.transitionMs,
    };
    this.north = options.north ?? d.north;
    this.autoRotateSpeed = options.autoRotateSpeed ?? d.autoRotateSpeed;
    this.autoRotateIdleMs = options.autoRotateIdleMs ?? d.autoRotateIdleMs;
    this.autoRotateEnabled = options.autoRotate ?? d.autoRotate;
    // No interaction has happened yet, so an enabled auto-rotate starts turning right away.
    this.autoRotateActive = this.autoRotateEnabled;
    // Clamped like setView: an embed config can say anything, and an
    // unclamped pitch past ±π/2 reaches viewMatrix as a mirrored view.
    const initialYaw = options.initialView?.yaw ?? 0;
    const initialPitch = clampPitch(options.initialView?.pitch ?? 0);
    const initialFov = clampFov(
      options.initialView?.fov ?? d.fov,
      this.opts.minFov,
      this.opts.maxFov,
    );
    this.view = { yaw: initialYaw, pitch: initialPitch, fov: initialFov };
    this.target = { yaw: initialYaw, pitch: initialPitch, fov: initialFov };
    this.renderer = new GLRenderer(container, {
      antialias: this.opts.antialias,
      maxPixelRatio: this.opts.maxPixelRatio,
      maxPixels: this.opts.maxPixels,
      onContextLost: this.onContextLost,
      onContextRestored: this.onContextRestored,
    });
    // The one layout read outside a resize: the size until the first
    // ResizeObserver callback reports it. Nothing is on screen yet, so the
    // first frame can wait for an animation frame.
    this.resizeTo(container.clientWidth, container.clientHeight, false);
    // project() works before the first frame too (chrome places itself as
    // soon as the viewer exists), so the camera it reads starts out current.
    viewProjection(this.view, this.aspect, this.opts.maxHorizontalFov, this.viewProj);
    dirInto(this.fwd, this.view.yaw, this.view.pitch);
    // Built once: the canvas and this host never change, and rebuilding it on
    // each load would drop a drag that is in progress when a scene swaps in.
    // The host is a private object, so the input methods stay off the
    // viewer's public surface.
    const host: ControlHost = {
      panByPixels: (dx, dy) => this.panByPixels(dx, dy),
      panTargetByPixels: (dx, dy) => this.panTargetByPixels(dx, dy),
      zoomAt: (scale, x, y) => this.zoomAt(scale, x, y),
      flick: (vx, vy) => this.flick(vx, vy),
      stopMomentum: () => this.stopMomentum(),
    };
    this.controls = new Controls(this.renderer.canvas, host, {
      wheel: options.wheel ?? d.wheel,
    });
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

  on = <K extends keyof PanoViewerEvents>(type: K, fn: (p: PanoViewerEvents[K]) => void) =>
    this.emitter.on(type, fn);

  off = <K extends keyof PanoViewerEvents>(type: K, fn: (p: PanoViewerEvents[K]) => void) =>
    this.emitter.off(type, fn);

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

  requestRender(): void {
    this.invalidate();
  }

  /**
   * Call `cb` after every frame drawn. The view it gets is a read-only copy,
   * rewritten in place each frame: read it during the call, don't keep it.
   */
  onRender(cb: (view: Readonly<View>) => void): () => void {
    this.renderCbs.add(cb);
    this.invalidate();
    return () => this.renderCbs.delete(cb);
  }

  /**
   * Load `pano`, swapping it in once its low-resolution base is resident.
   * Resolves true when it took effect and false when a newer load, a preview
   * or dispose() superseded it; rejects only for a load that is still current.
   * `options.view` is applied at the swap, with no easing from the old camera.
   *
   * WebGL context loss: a load in flight when the context is lost resolves
   * false, and so does one started while it is lost, which waits (its base
   * tiles cannot be uploaded) until the context is restored or the viewer is
   * disposed. Either way the viewer loads that pano itself once the context
   * is back, with the same view, and emits `ready` and `scene-change` for it;
   * if that reload fails it emits `load-error` instead.
   */
  async load(pano: string, options: LoadOptions = {}): Promise<boolean> {
    const token = this.supersede();
    const stale = () => this.disposed || token !== this.loadToken;
    const request: Reload = { pano, view: options.view, announce: true };
    this.request = request;
    try {
      const abort = new AbortController();
      this.manifestAbort = abort;
      this.emitter.emit('loading', pano);
      if (stale()) return false;

      let manifest;
      try {
        const res = await fetch(manifestUrl(this.opts.baseUrl, pano), { signal: abort.signal });
        if (stale()) return false;
        if (!res.ok) throw new Error(`manifest ${res.status}`);
        const json: unknown = await res.json();
        if (stale()) return false;
        manifest = parseManifest(json);
      } catch (err) {
        // An aborted or failed fetch for a load nobody is waiting on any more.
        if (stale()) return false;
        throw err;
      } finally {
        if (this.manifestAbort === abort) this.manifestAbort = undefined;
      }
      request.manifest = manifest;
      return await this.swapIn(token, { ...request, manifest });
    } finally {
      if (this.request === request) this.request = undefined;
    }
  }

  /**
   * Build a layer for `req`'s manifest, wait for its base, then put it on
   * screen in place of whatever is there. False when superseded.
   */
  private async swapIn(token: number, req: Reload & { manifest: Manifest }): Promise<boolean> {
    const stale = () => this.disposed || token !== this.loadToken;
    const { pano, manifest } = req;
    const layer = new TileLayer(
      this.renderer,
      manifest,
      this.opts.baseUrl,
      this.opts.textureBudgetMB,
      this.invalidate,
      this.opts.maxConcurrent,
    );
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
    this.layer?.dispose();
    this.layer = layer;
    this.scene = { pano, manifest };
    // A scene's own view is cut to, not eased to from the old scene's camera.
    // Only the axes it sets are cut; any other axis keeps easing as it was.
    const arrival = req.view;
    if (arrival) {
      this.setView(arrival);
      if (arrival.yaw !== undefined) this.view.yaw = this.target.yaw;
      if (arrival.pitch !== undefined) this.view.pitch = this.target.pitch;
      if (arrival.fov !== undefined) this.view.fov = this.target.fov;
    }
    this.stopMomentumOnly();
    if (this.preview && this.previewPano === pano) {
      // Replacing an image keeps the panoId, so the manifest can still be the
      // old image's until the new tiles are written. Those tiles are not the
      // preview's: it stays on top of them and outlives their tiles-settled.
      const own =
        this.previewReplaces === undefined || (manifest.version ?? '') !== this.previewReplaces;
      this.previewUnderlay = own;
      this.preview.setLevel(
        own
          ? previewDrawLevel(this.preview.width, manifest.tileSize, manifest.maxLevel)
          : manifest.maxLevel + 1,
      );
    } else {
      this.disposePreview();
    }
    this.wasPending = true;
    this.invalidate();
    if (!req.announce) return true;
    this.emitter.emit('ready', manifest);
    // A ready listener may have started another load or disposed the viewer;
    // the scene is then not changing to this one.
    if (!stale()) this.emitter.emit('scene-change', manifest.pano);
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
      (scene && { pano: scene.pano, view: undefined, manifest: scene.manifest, announce: false });
    this.lostRequest = undefined;
    this.disposePreview();
    this.invalidate();
    if (next) {
      this.reload(next).catch((error: unknown) => {
        // Nobody awaits this load, so the host hears about it as an event.
        this.emitter.emit('load-error', { error, id: next.pano });
      });
    }
    this.emitter.emit('context-restored', undefined);
  };

  private async reload(req: Reload): Promise<boolean> {
    const { manifest } = req;
    if (!manifest) return this.load(req.pano, req.view ? { view: req.view } : {});
    const token = this.supersede();
    const request: Reload = { ...req, manifest };
    this.request = request;
    try {
      return await this.swapIn(token, { ...request, manifest });
    } finally {
      if (this.request === request) this.request = undefined;
    }
  }

  /**
   * Queue the tiles `layer` needs for the camera it will arrive with: the
   * current target, with `view`'s axes applied as the swap will apply them.
   */
  private prime(layer: TileLayer, view: Partial<View> | undefined): void {
    const t = this.target;
    const arrival: View = {
      yaw: view?.yaw ?? t.yaw,
      pitch: view?.pitch === undefined ? t.pitch : clampPitch(view.pitch),
      fov: view?.fov === undefined ? t.fov : clampFov(view.fov, this.opts.minFov, this.opts.maxFov),
    };
    layer.update(
      viewProjection(arrival, this.aspect, this.opts.maxHorizontalFov),
      this.effectiveVFovDeg(arrival.fov),
      dirInto({ x: 0, y: 0, z: 0 }, arrival.yaw, arrival.pitch),
      this.renderer.canvas.height || 1,
    );
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
    this.manifestAbort?.abort();
    this.manifestAbort = undefined;
    for (const pending of this.pendingLayers) pending.dispose();
    this.pendingLayers.clear();
    if (this.transitionOverlay) dropOverlay(this.transitionOverlay);
    this.transitionOverlay = undefined;
    return token;
  }

  /**
   * Show a local decode of `panoId` now, in place of whatever is on screen,
   * keeping the camera.
   *
   * A later `load(panoId)` swaps the tiles in under it: once they are on screen
   * the preview paints over the tile levels no sharper than itself and under
   * the sharper ones (see `previewDrawLevel`), and is disposed at the next
   * `tiles-settled`. On a replace, `panoId` already has tiles from the old
   * image and the new version is not known until the server has tiled the
   * upload, so pass `options.replacesVersion`, the old manifest's version
   * (`''` for an unversioned one, as the upload machine's baseline has it). A
   * `load()` that gets a manifest with that version leaves the preview on top
   * of the old tiles and keeps it past their `tiles-settled`; any other
   * version is the preview's own. Without `replacesVersion` (a new pano), any
   * manifest for `panoId` is its own.
   *
   * Ownership: the patches' ImageBitmaps are closed as soon as they are on the
   * GPU (or straight away if the viewer is disposed or the source is
   * rejected), so a `PreviewSource` can be shown once. To show it again,
   * decode it again, e.g. from the stored WebP.
   *
   * Any `load()` in flight is cancelled, including one for `panoId`: it
   * resolves without swapping anything in. Call `load(panoId)` again after
   * this to get the tiles.
   */
  showPreview(
    panoId: string,
    source: PreviewSource,
    options: { replacesVersion?: string } = {},
  ): void {
    if (this.disposed) {
      closePreviewSource(source);
      return;
    }
    // Built first: a source that throws leaves the viewer exactly as it was.
    const preview = new EquirectLayer(this.renderer, source);
    this.supersede();
    this.disposePreview();
    this.preview = preview;
    this.previewPano = panoId;
    this.previewReplaces = options.replacesVersion;
    this.layer?.dispose();
    this.layer = undefined;
    this.scene = undefined;
    this.wasPending = false;
    this.stopMomentumOnly();
    this.invalidate();
    this.emitter.emit('scene-change', panoId);
  }

  private disposePreview(): void {
    this.preview?.dispose();
    this.preview = undefined;
    this.previewPano = undefined;
    this.previewReplaces = undefined;
    this.previewUnderlay = false;
  }

  // Painter's order is applied by the renderer, so the order here is free.
  private drawList(): DrawItem[] {
    const list = this.frameList;
    list.length = 0;
    if (!this.preview) return this.layer ? this.layer.drawList() : list;
    for (const item of this.preview.drawList()) list.push(item);
    if (this.layer) for (const item of this.layer.drawList()) list.push(item);
    return list;
  }

  /** Set the compass north offset (radians) for the currently loaded pano. */
  setNorth(radians: number): void {
    this.north = radians;
    this.invalidate();
  }

  /** Current compass heading (radians): north relative to the rendered yaw. */
  heading(): number {
    return compassHeading(this.view.yaw, this.north);
  }

  /** Enable or disable idle auto-rotate at runtime; interaction still pauses it. */
  setAutoRotate(enabled: boolean): void {
    this.autoRotateEnabled = enabled;
    clearTimeout(this.autoRotateResumeTimer);
    this.autoRotateResumeTimer = undefined;
    this.autoRotateActive = enabled;
    this.invalidate();
  }

  /** Report that a hotspot UI layer opened a hotspot, for analytics listeners. */
  reportHotspotOpen(hotspotId: string): void {
    this.emitter.emit('hotspot-open', hotspotId);
  }

  // Pause auto-rotate immediately and arm a timer to resume it once the
  // configured idle window passes with no further interaction.
  private pauseAutoRotate(): void {
    if (!this.autoRotateEnabled) return;
    this.autoRotateActive = false;
    clearTimeout(this.autoRotateResumeTimer);
    this.autoRotateResumeTimer = setTimeout(() => {
      this.autoRotateActive = true;
      this.invalidate();
    }, this.autoRotateIdleMs);
  }

  private autoRotating(): boolean {
    // A zero speed turns nothing, so it must not keep the loop running.
    return this.autoRotateEnabled && this.autoRotateActive && this.autoRotateSpeed !== 0;
  }

  private effectiveVFovDeg(requestedDeg: number): number {
    return effectiveVFovDeg(requestedDeg, this.opts.maxHorizontalFov, this.aspect);
  }

  /** Horizontal fov (rad) for a vertical one at the current aspect. */
  private hfovOf(vfov: number): number {
    return 2 * Math.atan(Math.tan(vfov / 2) * this.aspect);
  }

  private panByPixels(dx: number, dy: number): void {
    this.pauseAutoRotate();
    const vfov = this.effectiveVFovDeg(this.view.fov) * DEG2RAD;
    const hfov = this.hfovOf(vfov);
    // drag right → look left
    const yaw = unwound(this.view.yaw - dx * anglePerPixel(hfov, this.cssW));
    const pitch = clampPitch(this.view.pitch + dy * anglePerPixel(vfov, this.cssH));
    this.view.yaw = yaw;
    this.target.yaw = yaw;
    this.view.pitch = pitch;
    this.target.pitch = pitch;
    this.invalidate();
  }

  // panByPixels for the keyboard: moves only the target, so the frame loop's
  // damping eases the camera after it and key repeat glides.
  private panTargetByPixels(dx: number, dy: number): void {
    this.pauseAutoRotate();
    const vfov = this.effectiveVFovDeg(this.view.fov) * DEG2RAD;
    const hfov = this.hfovOf(vfov);
    this.target.yaw -= dx * anglePerPixel(hfov, this.cssW);
    this.target.pitch = clampPitch(this.target.pitch + dy * anglePerPixel(vfov, this.cssH));
    this.boundYaw();
    this.invalidate();
  }

  // flick takes px per 60 Hz frame; momentum is kept in rad/ms.
  private flick(vx: number, vy: number): void {
    this.pauseAutoRotate();
    const vfov = this.effectiveVFovDeg(this.view.fov) * DEG2RAD;
    const hfov = this.hfovOf(vfov);
    this.momentum.yaw = (-vx * anglePerPixel(hfov, this.cssW)) / FRAME_MS;
    this.momentum.pitch = (vy * anglePerPixel(vfov, this.cssH)) / FRAME_MS;
    this.invalidate();
  }

  // Yaw stays unbounded (wrapping target across ±π makes damp() swing the long
  // way); shift view and target together by whole turns only, so the float
  // stays bounded and the rendered angle does not move.
  private boundYaw(): void {
    if (Math.abs(this.target.yaw) <= TWO_PI) return;
    const shift = Math.trunc(this.target.yaw / TWO_PI) * TWO_PI;
    this.target.yaw -= shift;
    this.view.yaw -= shift;
  }

  private stopMomentum(): void {
    this.pauseAutoRotate();
    this.stopMomentumOnly();
  }

  // stopMomentum without counting as an interaction: programmatic moves
  // clear a glide but leave auto-rotate alone.
  private stopMomentumOnly(): void {
    this.momentum.yaw = 0;
    this.momentum.pitch = 0;
  }

  private zoomAt(scaleFactor: number, clientX: number, clientY: number): void {
    this.pauseAutoRotate();
    // The pointer is in client coordinates, so it is mapped through the
    // canvas's on-screen rect: page scroll moves it without a resize, and a
    // CSS transform scales it without changing the cached layout size.
    const rect = this.renderer.canvas.getBoundingClientRect();
    const nx = ((clientX - rect.left) / (rect.width || 1)) * 2 - 1;
    const ny = -(((clientY - rect.top) / (rect.height || 1)) * 2 - 1);
    const vfov0 = this.effectiveVFovDeg(this.view.fov) * DEG2RAD;
    const hfov0 = this.hfovOf(vfov0);
    const newReqDeg = clampFov(this.target.fov * scaleFactor, this.opts.minFov, this.opts.maxFov);
    const vfov1 = this.effectiveVFovDeg(newReqDeg) * DEG2RAD;
    const hfov1 = this.hfovOf(vfov1);
    const yaw = unwound(this.view.yaw + zoomAnchorDelta(nx, hfov0, hfov1));
    const pitch = clampPitch(this.view.pitch + zoomAnchorDelta(ny, vfov0, vfov1));
    this.view.yaw = yaw;
    this.target.yaw = yaw;
    this.view.pitch = pitch;
    this.target.pitch = pitch;
    this.view.fov = newReqDeg;
    this.target.fov = newReqDeg;
    this.invalidate();
  }

  setView(view: Partial<View>): void {
    // The rendered yaw is unbounded (drags and auto-rotate wind it up), so
    // aim at the equivalent angle nearest to it rather than the literal one,
    // which could be several turns away.
    if (view.yaw !== undefined)
      this.target.yaw = this.view.yaw + normalizeAngle(view.yaw - this.view.yaw);
    if (view.pitch !== undefined) this.target.pitch = clampPitch(view.pitch);
    if (view.fov !== undefined)
      this.target.fov = clampFov(view.fov, this.opts.minFov, this.opts.maxFov);
    this.stopMomentumOnly();
    this.invalidate();
  }

  /** The camera being moved to, with yaw in (−π, π]. */
  getView(): View {
    return { ...this.target, yaw: normalizeAngle(this.target.yaw) };
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
    this.resizeTo(this.cssW, this.cssH);
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
    this.cssW = width || 1;
    this.cssH = height || 1;
    this.aspect = this.cssW / this.cssH;
    if (!this.renderer.resize(this.cssW, this.cssH)) return;
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
    this.autoRotateLastFrame = undefined;
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
        ? FRAME_MS
        : Math.min(Math.max(t - this.lastFrameT, 0), MAX_FRAME_DT_MS);
    this.lastFrameT = t;

    if (this.autoRotating()) {
      // The first frame after (re)starting has no prior timestamp to diff
      // against, so it advances by zero rather than a stale or huge gap.
      const rotateMs =
        this.autoRotateLastFrame === undefined
          ? 0
          : Math.min(Math.max(t - this.autoRotateLastFrame, 0), MAX_FRAME_DT_MS);
      this.autoRotateLastFrame = t;
      this.target.yaw += this.autoRotateSpeed * (rotateMs / 1000);
      this.boundYaw();
    } else {
      this.autoRotateLastFrame = undefined;
    }

    this.dirty = false;
    const steps = dt / FRAME_MS;

    if (this.momentum.yaw !== 0 || this.momentum.pitch !== 0) {
      // Momentum decays exponentially, so a step travels the integral of the
      // decay over dt. Scaled so a 60 Hz step travels exactly one frame's
      // worth, the total glide is the same at every frame rate.
      const f = this.opts.momentumFriction;
      const keep = f ** steps;
      const travel = f < 1 ? (FRAME_MS * (1 - keep)) / (1 - f) : dt;
      this.target.yaw += this.momentum.yaw * travel;
      this.target.pitch = clampPitch(this.target.pitch + this.momentum.pitch * travel);
      this.momentum.yaw *= keep;
      this.momentum.pitch *= keep;
      if (Math.hypot(this.momentum.yaw, this.momentum.pitch) < MOMENTUM_EPS) {
        this.momentum.yaw = 0;
        this.momentum.pitch = 0;
      }
    }

    const k = 1 - (1 - this.opts.damping) ** steps;
    const view = this.view;
    const target = this.target;
    view.yaw = damp(view.yaw, target.yaw, k);
    view.pitch = damp(view.pitch, target.pitch, k);
    view.fov = damp(view.fov, target.fov, k);

    if (!this.cameraSettled()) {
      this.dirty = true;
    } else {
      view.yaw = target.yaw;
      view.pitch = target.pitch;
      view.fov = target.fov;
    }

    const vfovDeg = this.effectiveVFovDeg(view.fov);
    viewProjection(view, this.aspect, this.opts.maxHorizontalFov, this.viewProj);
    this.renderer.setCamera(this.viewProj);
    dirInto(this.fwd, view.yaw, view.pitch);
    // selectLevel()'s math (see lod.ts) compares texel
    // density against what is actually rasterised, so it needs the
    // framebuffer's device-pixel height, not the container's CSS-pixel
    // height — the renderer sizes the canvas by devicePixelRatio (see
    // gl-renderer.ts's resize()), so on any DPR>1 display the CSS height alone
    // under-counts the real pixel budget and the pyramid picks one level
    // coarser than the screen can show. this.renderer.canvas.height is the
    // already-DPR-scaled raster height, so it's used directly here instead
    // of re-deriving devicePixelRatio.
    this.layer?.update(this.viewProj, vfovDeg, this.fwd, this.renderer.canvas.height || 1);

    // Queued tiles count as pending: the queue outlasts a frame only while
    // every request slot is busy, and settling then would drop the preview
    // before its tiles exist. A tile that fails (for good, or until its
    // cooldown ends) does not count, so failed tiles can still end the
    // preview, leaving coarser tiles in their place.
    const pending = this.layer?.hasPending() ?? false;
    const tilesSettled = this.wasPending && !pending;
    if (tilesSettled && this.previewUnderlay) this.disposePreview();
    this.wasPending = pending;

    // Draw before anything outside the viewer runs: a listener that throws
    // or disposes the viewer must not cost this frame its render.
    this.renderer.render(this.drawList());
    if (tilesSettled) {
      try {
        this.emitter.emit('tiles-settled', undefined);
      } catch (err) {
        report(err);
      }
      if (this.disposed) return;
    }
    if (this.renderCbs.size > 0) {
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
    if (this.dirty || this.autoRotating()) {
      this.invalidate();
    } else {
      this.lastFrameT = undefined;
    }
  };

  /** No momentum left, and the camera has eased all the way to its target. */
  private cameraSettled(): boolean {
    const view = this.view;
    const target = this.target;
    return (
      this.momentum.yaw === 0 &&
      this.momentum.pitch === 0 &&
      Math.abs(target.yaw - view.yaw) < 1e-4 &&
      Math.abs(target.pitch - view.pitch) < 1e-4 &&
      Math.abs(target.fov - view.fov) < 1e-3
    );
  }

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
   * callback can call it between style writes.
   */
  project(yaw: number, pitch: number): { x: number; y: number; behind: boolean } {
    const d = dirInto(this.projectScratch, yaw, pitch);
    const ndc = projectDir(d, this.viewProj);
    const out = { x: 0, y: 0, behind: isBehind(d, this.fwd) };
    return ndcToPixel(ndc.x, ndc.y, this.cssW, this.cssH, out);
  }

  directionAtPixel(px: number, py: number): { yaw: number; pitch: number } {
    const ndcX = (px / this.cssW) * 2 - 1;
    const ndcY = -((py / this.cssH) * 2 - 1);
    const v = unprojectNDC(ndcX, ndcY, this.viewProj);
    const y = v.y < -1 ? -1 : v.y > 1 ? 1 : v.y;
    return { yaw: Math.atan2(v.x, -v.z), pitch: Math.asin(y) };
  }

  async transitionTo(pano: string, view?: Partial<View>): Promise<void> {
    if (this.disposed) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const ms = reduce ? 0 : this.opts.transitionMs;

    // Only snapshot when there is something to draw; snapshotting an empty draw
    // list would crossfade from a black frame.
    const drawList = this.drawList();
    // Started before the snapshot goes up: superseding the load in flight
    // removes an older transition's overlay (one that may still be fading),
    // and must not remove this one. Up to its first await, load() leaves the
    // scene on screen alone, so drawList is still what is drawn.
    const loading = this.load(pano, view ? { view } : {});
    let snap: HTMLCanvasElement | undefined;
    if (drawList.length > 0) {
      try {
        // A copy of the frame, made on the GPU; null while the context is lost.
        snap = this.renderer.snapshot(drawList) ?? undefined;
        if (snap) {
          snap.style.cssText =
            'position:absolute;inset:0;width:100%;height:100%;' +
            'pointer-events:none;transition:opacity ' +
            ms +
            'ms ease;opacity:1;z-index:5;';
          this.container.appendChild(snap);
          this.transitionOverlay = snap;
        }
      } catch {
        // snapshot unavailable — fall back to a plain fade
        snap = undefined;
      }
    }

    try {
      // Superseded: the newer call owns the camera and has already removed
      // this snapshot, so there is nothing to fade.
      const tookEffect = await loading;
      if (snap && tookEffect) {
        await new Promise((r) => requestAnimationFrame(() => r(null)));
        snap.style.opacity = '0';
        await new Promise((r) => setTimeout(r, ms));
      }
    } finally {
      // Always tear the overlay down — even if load() rejected — but don't
      // clobber an overlay a newer transitionTo may have installed.
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
    clearTimeout(this.autoRotateResumeTimer);
    window.removeEventListener('resize', this.onWindowResize);
    this.pixelRatioQuery?.removeEventListener('change', this.onPixelRatioChange);
    this.pixelRatioQuery = undefined;
    this.resizeObserver?.disconnect();
    this.intersectionObserver?.disconnect();
    this.controls.dispose();
    // Pending layers first: they are the ones with fetches still in flight, and
    // they must stop before the renderer's GL context is destroyed below.
    this.supersede();
    this.layer?.dispose();
    this.disposePreview();
    this.renderCbs.clear();
    this.renderer.dispose();
  }
}
