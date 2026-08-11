import { manifestUrl, parseManifest } from '@panote/core';
import { GLRenderer } from './render/gl-renderer.js';
import {
  viewProjection,
  effectiveVFovDeg,
  projectDir,
  unprojectNDC,
  type Mat4,
} from './render/projection.js';
import { TileLayer } from './tile-layer.js';
import { Controls } from './controls.js';
import type { ControlHost } from './controls.js';
import { Emitter } from './emitter.js';
import { clampPitch, clampFov, damp, anglePerPixel, zoomAnchorDelta } from './camera-math.js';
import type { View, ViewerOptions, PanoViewerEvents } from './types.js';
import { HotspotLayer, type HotspotHandle } from './hotspots.js';
import { dirFromYawPitch } from './project.js';

export class PanoViewer implements ControlHost {
  private renderer: GLRenderer;
  private emitter = new Emitter<PanoViewerEvents>();
  private controls?: Controls;
  private layer: TileLayer | undefined;
  private raf = 0;
  private dirty = true;
  private wasPending = false;
  private view: View;
  private target: View;
  private opts: Required<Omit<ViewerOptions, 'initialView'>>;
  private loadToken = 0;
  private disposed = false;
  private momentum = { yaw: 0, pitch: 0 };
  private hotspots = new HotspotLayer();
  private renderCbs = new Set<(view: View) => void>();
  private home: View;
  private transitionOverlay: HTMLDivElement | undefined;
  private resizeObserver: ResizeObserver | undefined;
  // The view-projection matrix for the frame currently being drawn.
  private viewProj: Mat4;

  constructor(
    private container: HTMLElement,
    options: ViewerOptions = {},
  ) {
    this.opts = {
      baseUrl: options.baseUrl ?? '/tiles/',
      minFov: options.minFov ?? 15,
      maxFov: options.maxFov ?? 80,
      maxHorizontalFov: options.maxHorizontalFov ?? 100,
      textureBudgetMB: options.textureBudgetMB ?? 128,
      damping: options.damping ?? 0.25,
      momentumFriction: options.momentumFriction ?? 0.9,
      maxPixelRatio: options.maxPixelRatio ?? 2,
      antialias: options.antialias ?? false,
      maxConcurrent: options.maxConcurrent ?? 8,
      transitionMs: options.transitionMs ?? 400,
    };
    const initialYaw = options.initialView?.yaw ?? 0;
    const initialPitch = options.initialView?.pitch ?? 0;
    const initialFov = options.initialView?.fov ?? Math.min(70, this.opts.maxFov);
    this.view = { yaw: initialYaw, pitch: initialPitch, fov: initialFov };
    this.target = { yaw: initialYaw, pitch: initialPitch, fov: initialFov };
    this.home = { ...this.view };
    this.renderer = new GLRenderer(container, {
      antialias: this.opts.antialias,
      maxPixelRatio: this.opts.maxPixelRatio,
    });
    this.renderer.resize(container.clientWidth || 1, container.clientHeight || 1);
    this.viewProj = viewProjection(this.view, this.aspect(), this.opts.maxHorizontalFov);
    window.addEventListener('resize', this.onResize);
    // window's resize event only fires on the browser viewport changing size,
    // not on the container itself being resized by layout — flex/grid
    // reflow, a sidebar toggling, display:none → visible, splitter panes.
    // ResizeObserver catches those too so the canvas doesn't get left at a
    // stale size/pixel ratio.
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(this.onResize);
      this.resizeObserver.observe(container);
    }
    this.loop();
  }

  on = this.boundOn();
  private boundOn() {
    return <K extends keyof PanoViewerEvents>(type: K, fn: (p: PanoViewerEvents[K]) => void) =>
      this.emitter.on(type, fn);
  }

  off = <K extends keyof PanoViewerEvents>(type: K, fn: (p: PanoViewerEvents[K]) => void) =>
    this.emitter.off(type, fn);

  get el(): HTMLElement {
    return this.container;
  }

  private aspect(): number {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    return w / h;
  }

  requestRender(): void {
    this.dirty = true;
  }

  onRender(cb: (view: View) => void): () => void {
    this.renderCbs.add(cb);
    this.dirty = true;
    return () => this.renderCbs.delete(cb);
  }

  async load(pano: string): Promise<void> {
    const token = ++this.loadToken;
    this.emitter.emit('loading', pano);

    const res = await fetch(manifestUrl(this.opts.baseUrl, pano));
    if (this.disposed || token !== this.loadToken) return;
    if (!res.ok) throw new Error(`manifest ${res.status}`);

    const manifest = parseManifest(await res.json());
    if (this.disposed || token !== this.loadToken) return;

    this.layer?.dispose();
    this.layer = undefined;

    const layer = new TileLayer(
      this.renderer,
      manifest,
      this.opts.baseUrl,
      this.opts.textureBudgetMB,
      () => {
        this.dirty = true;
      },
      this.opts.maxConcurrent,
    );
    await layer.loadPreview();

    if (this.disposed || token !== this.loadToken) {
      layer.dispose();
      return;
    }

    this.layer = layer;
    this.home = {
      yaw: this.target.yaw,
      pitch: this.target.pitch,
      fov: this.target.fov,
    };
    this.wasPending = true;
    this.controls?.dispose();
    this.controls = new Controls(this.renderer.canvas, this);
    this.dirty = true;
    this.emitter.emit('ready', manifest);
  }

  getFovLimits(): { min: number; max: number } {
    return { min: this.opts.minFov, max: this.opts.maxFov };
  }

  private effectiveVFovDeg(requestedDeg: number): number {
    return effectiveVFovDeg(requestedDeg, this.opts.maxHorizontalFov, this.aspect());
  }

  panByPixels(dx: number, dy: number): void {
    const W = this.container.clientWidth || 1;
    const H = this.container.clientHeight || 1;
    const vfov = (this.effectiveVFovDeg(this.view.fov) * Math.PI) / 180;
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * this.aspect());
    const yaw = this.view.yaw - dx * anglePerPixel(hfov, W); // drag right → look left
    const pitch = clampPitch(this.view.pitch + dy * anglePerPixel(vfov, H));
    this.view.yaw = yaw;
    this.target.yaw = yaw;
    this.view.pitch = pitch;
    this.target.pitch = pitch;
    this.dirty = true;
  }

  flick(vx: number, vy: number): void {
    const W = this.container.clientWidth || 1;
    const H = this.container.clientHeight || 1;
    const vfov = (this.effectiveVFovDeg(this.view.fov) * Math.PI) / 180;
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * this.aspect());
    this.momentum.yaw = -vx * anglePerPixel(hfov, W);
    this.momentum.pitch = vy * anglePerPixel(vfov, H);
    this.dirty = true;
  }

  stopMomentum(): void {
    this.momentum.yaw = 0;
    this.momentum.pitch = 0;
  }

  zoomAt(scaleFactor: number, clientX: number, clientY: number): void {
    const rect = this.renderer.canvas.getBoundingClientRect();
    const W = rect.width || 1;
    const H = rect.height || 1;
    const aspect = this.aspect();
    const nx = ((clientX - rect.left) / W) * 2 - 1;
    const ny = -(((clientY - rect.top) / H) * 2 - 1);
    const vfov0 = (this.effectiveVFovDeg(this.view.fov) * Math.PI) / 180;
    const hfov0 = 2 * Math.atan(Math.tan(vfov0 / 2) * aspect);
    const newReqDeg = clampFov(this.target.fov * scaleFactor, this.opts.minFov, this.opts.maxFov);
    const vfov1 = (this.effectiveVFovDeg(newReqDeg) * Math.PI) / 180;
    const hfov1 = 2 * Math.atan(Math.tan(vfov1 / 2) * aspect);
    const yaw = this.view.yaw + zoomAnchorDelta(nx, hfov0, hfov1);
    const pitch = clampPitch(this.view.pitch + zoomAnchorDelta(ny, vfov0, vfov1));
    this.view.yaw = yaw;
    this.target.yaw = yaw;
    this.view.pitch = pitch;
    this.target.pitch = pitch;
    this.view.fov = newReqDeg;
    this.target.fov = newReqDeg;
    this.dirty = true;
  }

  setView(view: Partial<View>): void {
    if (view.yaw !== undefined) this.target.yaw = view.yaw;
    if (view.pitch !== undefined) this.target.pitch = clampPitch(view.pitch);
    if (view.fov !== undefined)
      this.target.fov = clampFov(view.fov, this.opts.minFov, this.opts.maxFov);
    this.dirty = true;
  }

  getView(): View {
    return { ...this.target };
  }

  private onResize = () => {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.resize(w, h);
    this.dirty = true;
  };

  private loop = () => {
    this.raf = requestAnimationFrame(this.loop);
    if (!this.dirty) return;
    this.dirty = false;

    if (this.momentum.yaw !== 0 || this.momentum.pitch !== 0) {
      this.target.yaw += this.momentum.yaw;
      this.target.pitch = clampPitch(this.target.pitch + this.momentum.pitch);
      this.momentum.yaw *= this.opts.momentumFriction;
      this.momentum.pitch *= this.opts.momentumFriction;
      if (Math.hypot(this.momentum.yaw, this.momentum.pitch) < 1e-5) {
        this.momentum.yaw = 0;
        this.momentum.pitch = 0;
      }
    }

    const k = this.opts.damping;
    this.view.yaw = damp(this.view.yaw, this.target.yaw, k);
    this.view.pitch = damp(this.view.pitch, this.target.pitch, k);
    this.view.fov = damp(this.view.fov, this.target.fov, k);

    const settled =
      Math.abs(this.target.yaw - this.view.yaw) < 1e-4 &&
      Math.abs(this.target.pitch - this.view.pitch) < 1e-4 &&
      Math.abs(this.target.fov - this.view.fov) < 1e-3;

    if (!settled) {
      this.dirty = true;
    } else {
      this.view = { ...this.target };
    }

    const aspect = this.aspect();
    const vfovDeg = this.effectiveVFovDeg(this.view.fov);
    this.viewProj = viewProjection(this.view, aspect, this.opts.maxHorizontalFov);
    this.renderer.setCamera(this.viewProj);
    const fwd = dirFromYawPitch(this.view.yaw, this.view.pitch);
    // selectLevel()'s math (see packages/core/src/lod.ts) compares texel
    // density against what is actually rasterised, so it needs the
    // framebuffer's device-pixel height, not the container's CSS-pixel
    // clientHeight — the renderer sizes the canvas by devicePixelRatio (see
    // gl-renderer.ts's resize()), so on any DPR>1 display clientHeight alone
    // under-counts the real pixel budget and the pyramid picks one level
    // coarser than the screen can show. this.renderer.canvas.height is the
    // already-DPR-scaled raster height, so it's used directly here instead
    // of re-deriving devicePixelRatio.
    this.layer?.update(this.viewProj, vfovDeg, fwd, this.renderer.canvas.height || 1);

    const pending = this.layer?.hasPending() ?? false;
    if (this.wasPending && !pending) this.emitter.emit('tiles-settled', undefined);
    this.wasPending = pending;

    this.renderer.render(this.layer?.drawList() ?? []);
    this.hotspots.update(
      this.viewProj,
      fwd,
      this.container.clientWidth || 1,
      this.container.clientHeight || 1,
    );
    for (const cb of this.renderCbs) cb(this.view);
  };

  project(yaw: number, pitch: number): { x: number; y: number; behind: boolean } {
    const d = dirFromYawPitch(yaw, pitch);
    const fwd = dirFromYawPitch(this.view.yaw, this.view.pitch);
    const behind = d.x * fwd.x + d.y * fwd.y + d.z * fwd.z <= 0;
    const ndc = projectDir(d, this.viewProj);
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    return { x: (ndc.x * 0.5 + 0.5) * w, y: (-ndc.y * 0.5 + 0.5) * h, behind };
  }

  directionAtPixel(px: number, py: number): { yaw: number; pitch: number } {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    const ndcX = (px / w) * 2 - 1;
    const ndcY = -((py / h) * 2 - 1);
    const v = unprojectNDC(ndcX, ndcY, this.viewProj);
    const y = v.y < -1 ? -1 : v.y > 1 ? 1 : v.y;
    return { yaw: Math.atan2(v.x, -v.z), pitch: Math.asin(y) };
  }

  addHotspot(el: HTMLElement, pos: { yaw: number; pitch: number }): HotspotHandle {
    this.container.appendChild(el);
    return this.hotspots.add(el, pos.yaw, pos.pitch);
  }

  resetView(): void {
    this.setView({ ...this.home });
  }

  async transitionTo(pano: string, view?: Partial<View>): Promise<void> {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const ms = reduce ? 0 : this.opts.transitionMs;

    // A previous transition's overlay may still be fading — remove it now so it
    // can't outlive this call (and never crossfade two stale snapshots).
    this.transitionOverlay?.remove();
    this.transitionOverlay = undefined;

    // Only snapshot when there is something to draw; snapshotting an empty draw
    // list would crossfade from a black frame.
    const drawList = this.layer?.drawList();
    let snap: HTMLDivElement | undefined;
    if (drawList && drawList.length > 0) {
      snap = document.createElement('div');
      snap.style.cssText =
        'position:absolute;inset:0;background-size:cover;background-position:center;' +
        'pointer-events:none;transition:opacity ' +
        ms +
        'ms ease;opacity:1;z-index:5;';
      try {
        snap.style.backgroundImage = `url(${this.renderer.snapshot(drawList)})`;
        this.container.appendChild(snap);
        this.transitionOverlay = snap;
      } catch {
        // snapshot unavailable — fall back to a plain fade
        snap = undefined;
      }
    }

    try {
      await this.load(pano);
      if (view) this.setView(view);
      if (snap) {
        await new Promise((r) => requestAnimationFrame(() => r(null)));
        snap.style.opacity = '0';
        await new Promise((r) => setTimeout(r, ms));
      }
    } finally {
      // Always tear the overlay down — even if load() rejected — but don't
      // clobber an overlay a newer transitionTo may have installed.
      if (snap) {
        snap.remove();
        if (this.transitionOverlay === snap) this.transitionOverlay = undefined;
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    window.removeEventListener('resize', this.onResize);
    this.resizeObserver?.disconnect();
    this.controls?.dispose();
    this.layer?.dispose();
    this.hotspots.clear();
    this.renderCbs.clear();
    this.renderer.dispose();
  }
}
