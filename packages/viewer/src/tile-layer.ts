import { tilePath, type Manifest } from '@panote/core';
import { FACES, faceUVToDir, tileCornersUV, tilesPerEdge, type Face } from './cube.js';
import { selectLevel } from './lod.js';
import { selectEvictions } from './tile-cache.js';
import { maxTilesForBudget } from './texture-budget.js';
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
  type FailureKind,
} from './tile-retry.js';

/**
 * Why a single `ensureTile()` call ended. The per-frame path ignores this
 * entirely (a tile that did not load is simply re-queued next frame); the
 * base-layer load is the caller that has to act on it.
 */
type TileLoadOutcome =
  | { kind: 'loaded' } // in the cache now — this call, or already there
  | { kind: 'decoded' } // waiting in the ready queue for update() to upload it
  | { kind: 'skipped' } // another call owns it
  | { kind: 'aborted' } // cancelled: panned away, or the layer was disposed
  | { kind: 'failed'; failure: FailureKind; error: unknown };

/**
 * A level-0 tile could not be loaded, so the panorama has no low-resolution
 * base and the load fails. `cause` carries the underlying rejection (a
 * `TileHttpError` — exported from the package entry point alongside this class,
 * so the check is an `instanceof` and not a string match — a fetch `TypeError`,
 * or a decode error) for callers that want to distinguish "the origin is down"
 * from "this panorama is not published".
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
 * Wait between base-tile attempts. Injectable through the constructor, like
 * the clock: the tests advance time by hand rather than sleeping, so no test
 * waits on a real timer.
 *
 * The signal cuts the wait short — it is the layer's lifetime (see
 * `TileLayer.lifetime`), so a disposal is noticed within a microtask instead of
 * at the end of a cooldown that can be seconds long. It resolves rather than
 * rejects on abort: the caller re-checks `disposed` immediately afterwards, so
 * there is nothing an extra rejection path would add.
 */
const defaultSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });

interface TileEntry {
  key: string;
  handle: TileHandle;
  lastUsed: number;
  level: number;
  visible: boolean;
  /** Built once at upload, so drawList() pushes it without allocating. */
  item: DrawItem;
}

/** A decoded tile waiting for update() to upload it. */
interface ReadyTile {
  level: number;
  face: Face;
  x: number;
  y: number;
  bitmap: ImageBitmap;
}

/**
 * Uploads per update(). Each one is a texStorage2D, a texSubImage2D and a
 * mipmap generation, about 1-3 ms for a 512 px tile on a phone, so eight
 * decodes landing together would otherwise make one long frame.
 */
const MAX_UPLOADS_PER_UPDATE = 3;
/** Stop uploading for this update once this much time has gone. */
const UPLOAD_BUDGET_MS = 4;

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

function sameMatrix(a: Mat4, b: Float32Array): boolean {
  for (let k = 0; k < 16; k++) if (a[k] !== b[k]) return false;
  return true;
}

/** Floats per tile in a LevelTable: bounding sphere, then unit centre direction. */
const STRIDE = 7;
/** Bounding spheres are padded slightly so a tile at the frustum edge is kept. */
const CULL_PAD = 1.05;

/**
 * Everything update() needs about one pyramid level, computed once per layer
 * the first time that level is wanted, so the per-frame cull is plain
 * arithmetic. Tile `i = (faceIndex * g + y) * g + x`.
 */
interface LevelTable {
  /** Tiles per face edge. */
  g: number;
  /** Per tile: sphere centre xyz, padded radius, then the unit direction
   *  through the tile's UV centre (the load priority's axis). */
  data: Float32Array;
  /** Per tile cache key, so a frame builds no strings. */
  keys: string[];
}

function buildLevelTable(level: number): LevelTable {
  const g = tilesPerEdge(level);
  const count = FACES.length * g * g;
  const data = new Float32Array(count * STRIDE);
  const keys = new Array<string>(count);
  for (let f = 0; f < FACES.length; f++) {
    const face = FACES[f]!;
    for (let y = 0; y < g; y++) {
      for (let x = 0; x < g; x++) {
        const i = (f * g + y) * g + x;
        // Corners on the flat cube face, where the quad is drawn
        // (tile-geometry.ts), not on the sphere.
        const corners = tileCornersUV(level, x, y);
        const p = corners.map((c) => {
          const d = faceUVToDir(face, c.u, c.v);
          return { x: d.x * RADIUS, y: d.y * RADIUS, z: d.z * RADIUS };
        });
        const cx = (p[0]!.x + p[1]!.x + p[2]!.x + p[3]!.x) / 4;
        const cy = (p[0]!.y + p[1]!.y + p[2]!.y + p[3]!.y) / 4;
        const cz = (p[0]!.z + p[1]!.z + p[2]!.z + p[3]!.z) / 4;
        let r = 0;
        for (const q of p) r = Math.max(r, Math.hypot(q.x - cx, q.y - cy, q.z - cz));
        const md = faceUVToDir(
          face,
          (corners[0].u + corners[1].u) / 2,
          (corners[0].v + corners[2].v) / 2,
        );
        const mlen = Math.hypot(md.x, md.y, md.z) || 1;
        const o = i * STRIDE;
        data[o] = cx;
        data[o + 1] = cy;
        data[o + 2] = cz;
        data[o + 3] = r * CULL_PAD;
        data[o + 4] = md.x / mlen;
        data[o + 5] = md.y / mlen;
        data[o + 6] = md.z / mlen;
        keys[i] = tileKey(level, face, x, y);
      }
    }
  }
  return { g, data, keys };
}

/** Candidate order: nearest the view centre first. */
const byPriority = (a: Candidate, b: Candidate): number => a.priority - b.priority;

export class TileLayer {
  private cache = new Map<string, TileEntry>();
  private inflight = new Map<string, AbortController>();
  // Decoded and not yet uploaded, in arrival order. See drainReady().
  private ready = new Map<string, ReadyTile>();
  private queue: Candidate[] = [];
  // Next queue index pump() takes. A cursor rather than shift(), which is
  // O(n) per dequeue; update() replaces the queue and resets it every frame.
  private queueHead = 0;
  private clock = 0;
  private maxTiles: number;
  private maxConcurrent: number;
  private disposed = false;
  // Aborted by dispose(). Only the base loader's retry wait listens to it: the
  // in-flight fetches are cancelled through their own controllers in `inflight`.
  private lifetime = new AbortController();
  // The one wake timer: fires onInvalidate when a failed tile's cooldown ends,
  // so an idle viewer retries it without waiting for an interaction. `wakeAt`
  // is when it fires, on the retry clock, so an earlier need can replace a
  // later one.
  private wakeTimer: ReturnType<typeof setTimeout> | undefined;
  private wakeAt = Infinity;

  // Per-tile retry accounting for this panorama load. Replaces the old
  // permanent `failed` set: a transiently-failed tile stays re-queueable (so a
  // pan away and back refills the hole) until it exhausts its attempt budget,
  // while a 404/410 is still skipped for good. See tile-retry.ts.
  private retry: TileRetryBudget;

  // Reusable scratch buffers — no per-frame allocation.
  private frustum: Frustum = new Float32Array(24);
  private sphere = { cx: 0, cy: 0, cz: 0, r: 0 };
  private desired = new Set<string>();
  private candidates: Candidate[] = [];
  // Candidate objects are reused frame to frame: `candidates` holds the first
  // `candidates.length` of them.
  private candidatePool: Candidate[] = [];
  private _drawList: DrawItem[] = [];
  // Built lazily per level; see LevelTable.
  private levels: (LevelTable | undefined)[] = [];
  // Tile indices at `visibleLevel` that passed the cull, `visibleCount` long.
  private visible: Int32Array;
  private visibleCount = 0;
  private visibleLevel = -1;
  // The view the cull last ran for. An unchanged view and level reuse the
  // visible set: a tile landing asks for a frame but moves nothing.
  private lastViewProj = new Float32Array(16);

  constructor(
    private renderer: GLRenderer,
    private manifest: Manifest,
    private baseUrl: string,
    textureBudgetMB: number,
    private onInvalidate: () => void,
    maxConcurrent = 8,
    private now: () => number = () => performance.now(),
    private sleep: (ms: number, signal: AbortSignal) => Promise<void> = defaultSleep,
  ) {
    this.maxTiles = maxTilesForBudget(textureBudgetMB, manifest.tileSize);
    this.maxConcurrent = maxConcurrent;
    // Cooldowns and the wake timer share one clock (faked together in tests).
    this.retry = new TileRetryBudget(this.now);
    this.visible = new Int32Array(FACES.length * tilesPerEdge(manifest.maxLevel) ** 2);
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
      const result = await this.ensureTile(0, face, 0, 0);
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
      // The wait is cut short by dispose() rather than slept out — otherwise a
      // torn-down layer wakes up seconds later and issues another round of
      // fetches against a renderer that no longer has a GL context.
      if (wait > 0) await this.sleep(wait, this.lifetime.signal);
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
    if (this.disposed) return;
    this.clock++;
    const level = selectLevel(
      fovDeg,
      viewportHeight,
      this.manifest.tileSize,
      this.manifest.maxLevel,
    );
    if (level !== this.visibleLevel || !sameMatrix(viewProj, this.lastViewProj)) {
      this.lastViewProj.set(viewProj);
      frustumFromViewProj(viewProj, this.frustum);
      this.cull(level);
      this.desired.clear();
      const { keys } = this.table(level);
      for (let n = 0; n < this.visibleCount; n++) this.desired.add(keys[this.visible[n]!]!);
    }

    this.drainReady();

    // The candidates are rebuilt even for a still view: a tile that landed,
    // failed or finished its cooldown since the last frame changes them.
    this.candidates.length = 0;
    // Soonest a wanted tile that is cooling down after a failure may go again.
    let nextRetryMs = Infinity;
    const { g, data, keys } = this.table(level);
    for (let n = 0; n < this.visibleCount; n++) {
      const i = this.visible[n]!;
      const key = keys[i]!;
      const entry = this.cache.get(key);
      if (entry) {
        // Cached and still wanted — refresh LRU stamp so eviction reflects
        // actual visibility, not upload/insertion order.
        entry.lastUsed = this.clock;
      } else if (this.inflight.has(key) || this.ready.has(key)) {
        // On its way.
      } else if (this.retry.eligible(key)) {
        const o = i * STRIDE;
        // Smaller = closer to the view centre.
        const priority = 1 - (data[o + 4]! * fwd.x + data[o + 5]! * fwd.y + data[o + 6]! * fwd.z);
        const f = Math.floor(i / (g * g));
        const rest = i - f * g * g;
        this.pushCandidate(key, level, FACES[f]!, rest % g, Math.floor(rest / g), priority);
      } else {
        nextRetryMs = Math.min(nextRetryMs, this.retry.waitMs(key));
      }
    }

    // Abort inflight loads that are no longer in the desired set. Level-0
    // tiles are exempt: they are the base loadBase() is waiting on (and is
    // never in a deeper level's desired set), and once resident they are
    // pinned and drawn at every level, so one is never wasted work.
    for (const [key, controller] of this.inflight) {
      if (!this.desired.has(key) && !key.startsWith('0/')) {
        controller.abort();
        this.inflight.delete(key);
      }
    }

    // Sort candidates by priority ascending (nearest-to-centre first).
    this.candidates.sort(byPriority);
    this.queue = this.candidates;
    this.queueHead = 0;

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
    // Frames only run when something is dirty, so a hole waiting out a retry
    // cooldown on a still view needs its own wake.
    this.armWake(nextRetryMs);
  }

  /** Current visible draw list (coarse first is enforced by the renderer sort). */
  drawList(): DrawItem[] {
    this._drawList.length = 0;
    for (const entry of this.cache.values()) {
      if (entry.visible) {
        this._drawList.push(entry.item);
      }
    }
    return this._drawList;
  }

  private pump(): void {
    // ensureTile()'s `finally` pumps unconditionally, and dispose() aborts
    // every in-flight fetch at once — so without this guard a disposal frees
    // maxConcurrent slots and drains whatever update() last queued into a
    // fresh round of fetches that are downloaded and decoded only to be
    // discarded.
    if (this.disposed) return;
    while (this.inflight.size < this.maxConcurrent && this.queueHead < this.queue.length) {
      const next = this.queue[this.queueHead++]!;
      if (this.cache.has(next.key) || this.inflight.has(next.key) || this.ready.has(next.key)) {
        continue;
      }
      void this.ensureTile(next.level, next.face, next.x, next.y);
    }
  }

  /**
   * A frame is what refills and pumps the queue, and an idle viewer draws no
   * frames. Without a wake, a tile held by a per-tile retry cooldown would
   * wait for the next pan or zoom. One timer serves every tile: a later
   * request keeps the earlier timer, an earlier one replaces it.
   */
  private armWake(ms: number): void {
    if (this.disposed || !Number.isFinite(ms)) return;
    // At least 1 ms, so a clock that disagrees with the timer cannot spin.
    const delay = Math.max(1, ms);
    const at = this.now() + delay;
    if (this.wakeTimer !== undefined && this.wakeAt <= at) return;
    clearTimeout(this.wakeTimer);
    this.wakeAt = at;
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = undefined;
      this.wakeAt = Infinity;
      if (!this.disposed) this.onInvalidate();
    }, delay);
  }

  private table(level: number): LevelTable {
    let t = this.levels[level];
    if (!t) {
      t = buildLevelTable(level);
      this.levels[level] = t;
    }
    return t;
  }

  /**
   * Fill `visible` with the tiles at `level` whose padded bounding sphere
   * meets the frustum. Descends from level 0 and skips a subtree whose parent
   * is outside: a child's quad lies inside its parent's, so its padded sphere
   * lies inside the parent's and fails the same plane. Same result as testing
   * every tile, at O(visible × level) instead of O(4^level).
   */
  private cull(level: number): void {
    this.visibleCount = 0;
    this.visibleLevel = level;
    for (let f = 0; f < FACES.length; f++) this.descend(f, 0, 0, 0, level);
  }

  private descend(f: number, level: number, x: number, y: number, target: number): void {
    const t = this.table(level);
    const o = ((f * t.g + y) * t.g + x) * STRIDE;
    const sphere = this.sphere;
    sphere.cx = t.data[o]!;
    sphere.cy = t.data[o + 1]!;
    sphere.cz = t.data[o + 2]!;
    sphere.r = t.data[o + 3]!;
    if (!intersectsSphere(this.frustum, sphere)) return;
    if (level === target) {
      this.visible[this.visibleCount++] = o / STRIDE;
      return;
    }
    const cx = x * 2;
    const cy = y * 2;
    this.descend(f, level + 1, cx, cy, target);
    this.descend(f, level + 1, cx + 1, cy, target);
    this.descend(f, level + 1, cx, cy + 1, target);
    this.descend(f, level + 1, cx + 1, cy + 1, target);
  }

  private pushCandidate(
    key: string,
    level: number,
    face: Face,
    x: number,
    y: number,
    priority: number,
  ): void {
    let c = this.candidatePool[this.candidates.length];
    if (c) {
      c.key = key;
      c.level = level;
      c.face = face;
      c.x = x;
      c.y = y;
      c.priority = priority;
    } else {
      c = { key, level, face, x, y, priority };
      this.candidatePool.push(c);
    }
    this.candidates.push(c);
  }

  private async ensureTile(
    level: number,
    face: Face,
    x: number,
    y: number,
  ): Promise<TileLoadOutcome> {
    if (this.disposed) return { kind: 'aborted' };
    const key = tileKey(level, face, x, y);
    if (this.cache.has(key)) return { kind: 'loaded' };
    if (this.inflight.has(key) || this.ready.has(key)) return { kind: 'skipped' };
    const url = tilePath(
      this.baseUrl,
      this.manifest.pano,
      level,
      face,
      x,
      y,
      this.manifest.format,
      this.manifest.version,
    );
    const controller = new AbortController();
    this.inflight.set(key, controller);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) throw new TileHttpError(res.status);
      const blob = await res.blob();
      // Decoded upright (row 0 = top). The renderer uploads it unflipped and
      // the tile UVs address row 0 as v = 0 (see tile-geometry.ts).
      const bitmap = await createImageBitmap(blob);
      if (this.disposed) {
        bitmap.close();
        return { kind: 'aborted' };
      }
      // An earlier load of this key can finish first: update() aborts a tile
      // that leaves the view, but createImageBitmap ignores the signal, so a
      // load aborted mid-decode still lands — after a reload has started. The
      // second one to land must not upload over the first, or the first
      // texture is never freed.
      if (this.cache.has(key) || this.ready.has(key)) {
        bitmap.close();
        return { kind: 'loaded' };
      }
      // The base goes up at once: loadBase() is waiting on it, and no frame
      // runs while the layer is still loading. Everything else waits for
      // update() to upload it, a few per frame.
      if (level === 0) {
        this.upload(key, level, face, x, y, bitmap);
        return { kind: 'loaded' };
      }
      this.ready.set(key, { level, face, x, y, bitmap });
      this.onInvalidate();
      return { kind: 'decoded' };
    } catch (err) {
      // Abort (from AbortController) is expected churn — leave re-queueable
      // and spend no attempt. Everything else is classified: a permanent
      // status (404/410/401/403) retires the tile for this load, a transient
      // one costs an attempt. Either way the coarser parent tile stays as
      // fallback.
      if (isAbortError(err)) return { kind: 'aborted' };
      const failure = this.recordFailure(key, err);
      return { kind: 'failed', failure, error: err };
    } finally {
      // Only clear the slot this call owns. After an abort the key may already
      // belong to a reload, which must stay tracked: it still counts against
      // maxConcurrent and update() must still be able to abort it.
      if (this.inflight.get(key) === controller) this.inflight.delete(key);
      this.pump(); // a slot freed — start more queued loads
    }
  }

  /** Upload a decoded tile and cache it. Closes the bitmap, even on a throw. */
  private upload(
    key: string,
    level: number,
    face: Face,
    x: number,
    y: number,
    bitmap: ImageBitmap,
  ): void {
    const geom = buildTileGeometry(face, level, x, y);
    let handle: TileHandle;
    try {
      handle = this.renderer.uploadTile(geom, bitmap);
    } finally {
      // The GPU texture owns the pixels now (or the upload failed, e.g. on a
      // lost context): free the CPU copy either way.
      bitmap.close();
    }
    this.cache.set(key, {
      key,
      handle,
      lastUsed: this.clock,
      level,
      visible: true,
      item: { handle, level },
    });
    this.retry.recordSuccess(key);
    this.onInvalidate();
  }

  private recordFailure(key: string, err: unknown): FailureKind {
    const failure = classifyFailure(err);
    this.retry.recordFailure(key, failure);
    // Still on screen: come back for it when its cooldown ends, even if
    // nothing else asks for a frame before then.
    if (this.desired.has(key)) this.armWake(this.retry.waitMs(key));
    return failure;
  }

  /**
   * Upload what has decoded since the last frame: at most
   * MAX_UPLOADS_PER_UPDATE, and none once UPLOAD_BUDGET_MS has gone, so a
   * burst of decodes is spread over several frames instead of one long one.
   * A tile that left the view while it waited is dropped and its bitmap
   * closed. Anything left over asks for another frame.
   */
  private drainReady(): void {
    if (this.ready.size === 0) return;
    const start = this.now();
    let uploads = 0;
    for (const [key, tile] of this.ready) {
      if (!this.desired.has(key)) {
        tile.bitmap.close();
        this.ready.delete(key);
        continue;
      }
      if (uploads >= MAX_UPLOADS_PER_UPDATE || this.now() - start >= UPLOAD_BUDGET_MS) continue;
      this.ready.delete(key);
      uploads++;
      try {
        this.upload(key, tile.level, tile.face, tile.x, tile.y, tile.bitmap);
      } catch (err) {
        this.recordFailure(key, err);
      }
    }
    if (this.ready.size > 0) this.onInvalidate();
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
      this.clock,
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

  /**
   * Is any tile for the current view still to come? In flight, decoded and
   * waiting to be uploaded, or queued: the
   * queue is non-empty after pump() only when every slot is busy, and a held
   * queue is work that has not happened yet, not work that is done. A tile that failed is in neither
   * (it is out of the queue while it waits out a per-tile cooldown, and for
   * good once it is permanent or out of attempts), so failures do not keep
   * this true.
   */
  hasPending(): boolean {
    return this.inflight.size > 0 || this.ready.size > 0 || this.queueHead < this.queue.length;
  }

  dispose(): void {
    this.disposed = true;
    // Cuts short the base loader's retry wait; the fetches themselves are
    // cancelled through their own controllers just below.
    this.lifetime.abort();
    clearTimeout(this.wakeTimer);
    this.wakeTimer = undefined;
    this.wakeAt = Infinity;
    // The queue is what pump() would otherwise drain the moment those aborts
    // free their concurrency slots.
    this.queue = [];
    this.queueHead = 0;
    this.candidates.length = 0;
    this.desired.clear();
    this.visibleCount = 0;
    this.visibleLevel = -1;
    for (const c of this.inflight.values()) c.abort();
    this.inflight.clear();
    for (const tile of this.ready.values()) tile.bitmap.close();
    this.ready.clear();
    for (const e of this.cache.values()) {
      this.renderer.removeTile(e.handle);
    }
    this.cache.clear();
    this.retry.clear();
  }
}
