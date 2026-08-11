import {
  FACES,
  faceUVToDir,
  selectLevel,
  tileCornersUV,
  tilePath,
  tilesPerEdge,
  type Face,
  type Manifest,
} from '@panote/core';
import { selectEvictions } from './tile-cache.js';
import { RADIUS, buildTileGeometry } from './tile-geometry.js';
import {
  frustumFromViewProj,
  intersectsSphere,
  type Frustum,
  type Mat4,
} from './render/projection.js';
import type { GLRenderer, DrawItem, TileHandle } from './render/gl-renderer.js';
import {
  TileHttpError,
  TileRetryBudget,
  classifyFailure,
  isAbortError,
  sharedTileFailureMonitor,
  type FailureKind,
  type TileFailureMonitor,
} from './tile-retry.js';

/**
 * Why a single `ensureTile()` call ended. The per-frame path ignores this
 * entirely (a tile that did not load is simply re-queued next frame); the
 * base-layer load is the caller that has to act on it.
 */
type TileLoadOutcome =
  | { kind: 'loaded' } // in the cache now — this call, or already there
  | { kind: 'skipped' } // another call owns it, or the backoff suppressed it
  | { kind: 'aborted' } // cancelled: panned away, or the layer was disposed
  | { kind: 'failed'; failure: FailureKind; error: unknown };

/**
 * A level-0 tile could not be loaded, so the panorama has no low-resolution
 * base and the load fails. `cause` carries the underlying rejection (a
 * `TileHttpError`, a fetch `TypeError`, a decode error) for callers that want
 * to distinguish "the origin is down" from "this panorama is not published".
 *
 * `permanent` is that distinction pre-classified: `true` for a 404/410/401/403
 * (retrying cannot help — the panorama is not published, or not accessible to
 * this caller), `false` for everything else (a timeout, a 5xx, a dropped
 * connection — the origin is unavailable right now). It is derived with the
 * same `classifyFailure` the retry budget itself uses, so a caller can check
 * `error.permanent` instead of inspecting or string-matching `cause`.
 */
export class BaseTileLoadError extends Error {
  readonly permanent: boolean;

  constructor(
    readonly pano: string,
    readonly face: Face,
    cause: unknown,
  ) {
    const reason = cause instanceof Error ? cause.message : String(cause ?? 'no attempt succeeded');
    super(`panorama "${pano}": low-resolution base tile for face "${face}" failed (${reason})`, {
      cause,
    });
    this.name = 'BaseTileLoadError';
    this.permanent = classifyFailure(cause) === 'permanent';
  }
}

/**
 * Wait between base-tile attempts. Injectable through the constructor for the
 * same reason the failure monitor owns the clock: the tests advance time by
 * hand rather than sleeping, so no test waits on a real timer.
 */
const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

interface TileEntry {
  key: string;
  handle: TileHandle;
  lastUsed: number;
  level: number;
  visible: boolean;
}

interface Candidate {
  key: string;
  level: number;
  face: Face;
  x: number;
  y: number;
  priority: number;
}

function tileKey(level: number, face: string, x: number, y: number): string {
  return `${level}/${face}/${x}-${y}`;
}

export class TileLayer {
  private cache = new Map<string, TileEntry>();
  private inflight = new Map<string, AbortController>();
  private queue: Candidate[] = [];
  private clock = 0;
  private maxTiles: number;
  private maxConcurrent: number;
  private disposed = false;

  // Per-tile retry accounting for this panorama load. Replaces the old
  // permanent `failed` set: a transiently-failed tile stays re-queueable (so a
  // pan away and back refills the hole) until it exhausts its attempt budget,
  // while a 404/410 is still skipped for good. See tile-retry.ts.
  private retry: TileRetryBudget;
  private monitor: TileFailureMonitor;

  // Reusable scratch buffers — no per-frame allocation.
  private frustum: Frustum | null = null;
  private desired = new Set<string>();
  private candidates: Candidate[] = [];
  private _drawList: DrawItem[] = [];
  // Written by tileVisible: unit direction through the tile's UV centre, reused
  // by update() for the load-priority dot product (avoids recomputing corners).
  private midDirX = 0;
  private midDirY = 0;
  private midDirZ = 0;

  constructor(
    private renderer: GLRenderer,
    private manifest: Manifest,
    private baseUrl: string,
    textureBudgetMB: number,
    private onInvalidate: () => void,
    maxConcurrent = 8,
    monitor: TileFailureMonitor = sharedTileFailureMonitor(),
    private sleep: (ms: number) => Promise<void> = defaultSleep,
  ) {
    const tileMB = (manifest.tileSize * manifest.tileSize * 4) / (1024 * 1024);
    this.maxTiles = Math.max(24, Math.floor(textureBudgetMB / tileMB));
    this.maxConcurrent = maxConcurrent;
    // The monitor owns the clock so per-tile cooldowns and the global backoff
    // measure time the same way (and are faked together in tests).
    this.monitor = monitor;
    this.retry = new TileRetryBudget(() => this.monitor.now());
  }

  /**
   * Load the low-resolution base layer: the six level-0 tiles, which are
   * exactly one tile per cube face and therefore a complete, if soft, copy of
   * the whole panorama.
   *
   * Blocking and fatal by design. Once these six are resident every direction
   * has *some* texture, `selectEvictions()` pins them against LRU eviction, and
   * `update()` keeps them visible at every level — so a high-resolution tile
   * that 404s, times out or exhausts its retries degrades to soft detail
   * instead of leaving a black patch. That guarantee only holds if the base is
   * actually there, so a panorama that cannot load it is not a panorama that
   * loaded: this rejects rather than leaving the viewer to discover the hole
   * one hole at a time.
   *
   * Every failure still flows through the shared failure monitor (see
   * `acquireExempt()`), so cross-panorama outage detection keeps working — the
   * load just fails regardless of what the backoff would have preferred.
   */
  async loadBase(): Promise<void> {
    // allSettled, not all: a rejection from one face must not leave the other
    // five rejecting unobserved into an unhandled rejection.
    const results = await Promise.allSettled(FACES.map((f) => this.loadBaseFace(f as Face)));
    for (const result of results) {
      if (result.status === 'rejected') throw result.reason as Error;
    }
  }

  /**
   * One face of the base layer, retried in place. Unlike the per-frame path
   * there is no next frame to re-queue into, so the wait is taken here — but
   * the budget and the cooldowns are the same ones every other tile uses, so a
   * blip on one of six requests costs a second, not the load.
   */
  private async loadBaseFace(face: Face): Promise<void> {
    const key = tileKey(0, face, 0, 0);
    let cause: unknown;
    for (;;) {
      const result = await this.ensureTile(0, face, 0, 0, true);
      if (result.kind === 'loaded') return;
      // Disposal (or a newer load superseding this one) tears the layer down
      // mid-flight. That is not the base layer failing — the caller already
      // discards this load — so it resolves quietly rather than reporting an
      // error nobody is waiting for.
      if (this.disposed) return;
      // 'skipped'/'aborted' spend no attempt, so retrying would spin: the only
      // producers are a concurrent load of the same key or a cancellation the
      // layer did not ask for, and neither resolves by asking again.
      if (result.kind !== 'failed') break;
      cause = result.error;
      // Infinity once the tile is permanent (404/410/401/403) or has spent its
      // attempts — either way there is nothing left to wait for. A permanent
      // status therefore fails the load on the first response, without burning
      // three requests on a URL that cannot start existing.
      const wait = this.retry.waitMs(key);
      if (!Number.isFinite(wait)) break;
      if (wait > 0) await this.sleep(wait);
      if (this.disposed) return;
    }
    throw new BaseTileLoadError(this.manifest.pano, face, cause);
  }

  /** Per-frame: pick the target level, cull, ensure visible tiles, evict. */
  update(
    viewProj: Mat4,
    fovDeg: number,
    fwd: { x: number; y: number; z: number },
    viewportHeight: number,
  ): void {
    this.clock++;
    const level = selectLevel(
      fovDeg,
      viewportHeight,
      this.manifest.tileSize,
      this.manifest.maxLevel,
    );
    this.frustum = frustumFromViewProj(viewProj);

    this.desired.clear();
    this.candidates.length = 0;

    for (const face of FACES) {
      const g = tilesPerEdge(level);
      for (let y = 0; y < g; y++) {
        for (let x = 0; x < g; x++) {
          if (this.tileVisible(face as Face, level, x, y)) {
            const key = tileKey(level, face, x, y);
            this.desired.add(key);
            const entry = this.cache.get(key);
            if (entry) {
              // Cached and still wanted — refresh LRU stamp so eviction reflects
              // actual visibility, not upload/insertion order.
              entry.lastUsed = this.clock;
            } else if (!this.inflight.has(key) && this.retry.eligible(key)) {
              // tileVisible wrote the unit centre direction into midDir* — reuse
              // it for the load priority (smaller = closer to camera centre).
              const priority =
                1 - (this.midDirX * fwd.x + this.midDirY * fwd.y + this.midDirZ * fwd.z);
              this.candidates.push({
                key,
                level,
                face: face as Face,
                x,
                y,
                priority,
              });
            }
          }
        }
      }
    }

    // Abort inflight loads that are no longer in the desired set.
    for (const [key, controller] of this.inflight) {
      if (!this.desired.has(key)) {
        controller.abort();
        this.inflight.delete(key);
      }
    }

    // Sort candidates by priority ascending (nearest-to-centre first).
    this.candidates.sort((a, b) => a.priority - b.priority);
    this.queue = this.candidates;

    // Hide tiles finer than the current target level to prevent stale
    // higher-LOD tiles from drawing on top after a zoom-out.
    //
    // The converse is the coarse fallback, and it is why a hole can never show
    // through: every *coarser* resident tile stays visible, drawList() emits
    // them all and the renderer paints them low-level-first (sortDrawList in
    // render/gl-renderer.ts, with depth testing off), so a finer tile that is
    // absent simply leaves its ancestor's texels on screen. loadBase()
    // guarantees the level-0 ancestor is resident and selectEvictions() never
    // evicts it, so that floor always exists.
    for (const entry of this.cache.values()) {
      entry.visible = entry.level <= level;
    }

    this.evict();
    this.pump();
  }

  /** Current visible draw list (coarse first is enforced by the renderer sort). */
  drawList(): DrawItem[] {
    this._drawList.length = 0;
    for (const entry of this.cache.values()) {
      if (entry.visible) {
        this._drawList.push({ handle: entry.handle, level: entry.level });
      }
    }
    return this._drawList;
  }

  private pump(): void {
    while (this.inflight.size < this.maxConcurrent && this.queue.length > 0) {
      // Global backoff: hold the queue intact rather than draining it into
      // no-op ensureTile calls. update() rebuilds it next frame anyway, and
      // the one probe the monitor allows is started from here too.
      if (!this.monitor.canStart()) return;
      const next = this.queue.shift()!;
      if (this.cache.has(next.key) || this.inflight.has(next.key)) continue;
      void this.ensureTile(next.level, next.face, next.x, next.y);
    }
  }

  private tileVisible(face: Face, level: number, x: number, y: number): boolean {
    // Cull against the flat-quad bounds (padded slightly). tileCornersUV returns
    // [TL, TR, BL, BR]. Also derive the UV-centre unit direction into midDir*
    // scratch for update()'s load priority. Scalar locals only — no per-call
    // object/array allocation.
    const corners = tileCornersUV(level, x, y);
    // UV-centre direction (matches the former faceUVToDir(uMid, vMid)).
    const uMid = (corners[0]!.u + corners[1]!.u) / 2;
    const vMid = (corners[0]!.v + corners[2]!.v) / 2;
    const md = faceUVToDir(face, uMid, vMid);
    const mlen = Math.hypot(md.x, md.y, md.z) || 1;
    this.midDirX = md.x / mlen;
    this.midDirY = md.y / mlen;
    this.midDirZ = md.z / mlen;

    if (!this.frustum) return true;

    // Corner positions on the flat cube face, accumulated as scalars.
    const d0 = faceUVToDir(face, corners[0]!.u, corners[0]!.v);
    const d1 = faceUVToDir(face, corners[1]!.u, corners[1]!.v);
    const d2 = faceUVToDir(face, corners[2]!.u, corners[2]!.v);
    const d3 = faceUVToDir(face, corners[3]!.u, corners[3]!.v);
    const p0x = d0.x * RADIUS,
      p0y = d0.y * RADIUS,
      p0z = d0.z * RADIUS;
    const p1x = d1.x * RADIUS,
      p1y = d1.y * RADIUS,
      p1z = d1.z * RADIUS;
    const p2x = d2.x * RADIUS,
      p2y = d2.y * RADIUS,
      p2z = d2.z * RADIUS;
    const p3x = d3.x * RADIUS,
      p3y = d3.y * RADIUS,
      p3z = d3.z * RADIUS;
    const cx = (p0x + p1x + p2x + p3x) / 4;
    const cy = (p0y + p1y + p2y + p3y) / 4;
    const cz = (p0z + p1z + p2z + p3z) / 4;
    let r = Math.hypot(p0x - cx, p0y - cy, p0z - cz);
    r = Math.max(r, Math.hypot(p1x - cx, p1y - cy, p1z - cz));
    r = Math.max(r, Math.hypot(p2x - cx, p2y - cy, p2z - cz));
    r = Math.max(r, Math.hypot(p3x - cx, p3y - cy, p3z - cz));
    return intersectsSphere(this.frustum, { cx, cy, cz, r: r * 1.05 });
  }

  private async ensureTile(
    level: number,
    face: Face,
    x: number,
    y: number,
    exempt = false,
  ): Promise<TileLoadOutcome> {
    const key = tileKey(level, face, x, y);
    if (this.cache.has(key)) return { kind: 'loaded' };
    if (this.inflight.has(key)) return { kind: 'skipped' };
    // Suppressed by the cross-panorama backoff — not a failure, and no attempt
    // is spent, so the tile is re-queued unchanged once the window clears.
    // Base tiles are exempt from suppression but not from reporting; see
    // TileFailureMonitor.acquireExempt().
    const permit = exempt ? this.monitor.acquireExempt() : this.monitor.acquire();
    if (!permit) return { kind: 'skipped' };
    const url = tilePath(this.baseUrl, this.manifest.pano, level, face, x, y, this.manifest.format);
    const controller = new AbortController();
    this.inflight.set(key, controller);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) throw new TileHttpError(res.status);
      const blob = await res.blob();
      // flipY at decode time to match the previous Image-based orientation.
      const bitmap = await createImageBitmap(blob, {
        imageOrientation: 'flipY',
      });
      if (this.disposed) {
        bitmap.close();
        return { kind: 'aborted' };
      }
      const geom = buildTileGeometry(face, level, x, y);
      const handle = this.renderer.uploadTile(geom, bitmap);
      bitmap.close(); // GPU texture owns the pixels now; free the CPU copy.
      this.cache.set(key, {
        key,
        handle,
        lastUsed: this.clock,
        level,
        visible: true,
      });
      this.retry.recordSuccess(key);
      this.monitor.succeed(permit);
      this.onInvalidate();
      return { kind: 'loaded' };
    } catch (err) {
      // Abort (from AbortController) is expected churn — leave re-queueable,
      // spend no attempt and tell the monitor nothing. Everything else is
      // classified: a permanent status (404/410/401/403) retires the tile for
      // this load, a transient one costs an attempt and feeds the global
      // failure monitor. Either way the coarser parent tile stays as fallback.
      if (isAbortError(err)) return { kind: 'aborted' };
      const failure = classifyFailure(err);
      this.retry.recordFailure(key, failure);
      this.monitor.fail(permit, this.manifest.pano, failure);
      return { kind: 'failed', failure, error: err };
    } finally {
      // No-op when succeed()/fail() already settled it; this covers the
      // abort and disposed-mid-load paths, which must still free the probe.
      this.monitor.release(permit);
      this.inflight.delete(key);
      this.pump(); // a slot freed — start more queued loads
    }
  }

  private evict(): void {
    // Nothing can be evicted while under budget — skip the O(cacheSize)
    // candidate array allocation entirely.
    if (this.cache.size <= this.maxTiles) return;
    const keysToRemove = selectEvictions(
      [...this.cache.values()].map((e) => ({
        key: e.key,
        lastUsed: e.lastUsed,
      })),
      this.maxTiles,
    );
    for (const key of keysToRemove) {
      const e = this.cache.get(key);
      if (!e) continue;
      this.renderer.removeTile(e.handle);
      this.cache.delete(key);
    }
    if (keysToRemove.length > 0) {
      this.onInvalidate();
    }
  }

  hasPending(): boolean {
    return this.inflight.size > 0;
  }

  dispose(): void {
    this.disposed = true;
    for (const c of this.inflight.values()) c.abort();
    this.inflight.clear();
    for (const e of this.cache.values()) {
      this.renderer.removeTile(e.handle);
    }
    this.cache.clear();
    this.retry.clear();
  }
}
