import { FACES, faceUVInto, tilesPerEdge, type Face } from './cube.js';
import type { Vec3 } from './project.js';
import { LOD_TOLERANCE, selectLevel } from './lod.js';
import { pickEvictions } from './tile-cache.js';
import { maxTilesForBudget } from './texture-budget.js';
import { RADIUS, buildTileGeometry } from './tile-geometry.js';
import {
  frustumFromViewProj,
  intersectsSphere,
  sameMatrix,
  type Frustum,
  type Mat4,
} from './render/projection.js';
import {
  ContextLostError,
  type GLRenderer,
  type DrawItem,
  type TileHandle,
} from './render/gl-renderer.js';
import type { CubeTileSource, TileImage } from './source.js';
import { loadTileImage, releaseImage, type TileNetwork } from './tile-fetch.js';
import {
  TileRetryBudget,
  classifyFailure,
  isAbortError,
  type FailureKind,
  type TileRetryOptions,
} from './tile-retry.js';

/** How a layer loads and keeps tiles; the viewer fills these from ViewerOptions. */
export interface TileLayerOptions {
  /** Resident tile textures, MB of VRAM. */
  textureBudgetMB: number;
  /** Most requests in flight (`network.maxConcurrent`). */
  maxConcurrent: number;
  /** Fewest tiles kept resident (`memory.minResidentTiles`). */
  minResidentTiles: number;
  /** Added to the LOD tolerance; positive picks coarser levels (`rendering.lodBias`). */
  lodBias: number;
  /** Per-tile retry budget (`network.retry`). */
  retry: TileRetryOptions;
  network?: TileNetwork;
  /** Most decoded tiles uploaded per frame. Default 8; the viewer passes 4 on a phone. */
  maxUploadsPerUpdate?: number;
  /** Test seam: the clock retry cooldowns and the wake timer run on. */
  now?: () => number;
  /** Test seam: the wait between base-tile attempts. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

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
  | { kind: 'lost' } // decoded, but the WebGL context is lost and it cannot go up
  | { kind: 'failed'; failure: FailureKind; error: unknown };

/**
 * A level-0 tile could not be loaded, so the panorama has no low-resolution
 * base and the load fails. `sourceId` is the id of the source that failed.
 * `cause` carries the underlying rejection (a `TileHttpError` — exported from
 * the package entry point alongside this class, so the check is an
 * `instanceof` and not a string match — a fetch `TypeError`, a decode error,
 * or whatever a source's `loadTile` rejected with) for callers that want to
 * distinguish "the origin is down" from "this panorama is not published".
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
    readonly sourceId: string,
    readonly face: Face,
    cause: unknown,
  ) {
    const reason = cause instanceof Error ? cause.message : String(cause ?? 'no attempt succeeded');
    super(
      `panorama "${sourceId}": low-resolution base tile for face "${face}" failed (${reason})`,
      {
        cause,
      },
    );
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

/** Resolves once `signal` aborts. */
function untilAborted(signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

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
  bitmap: TileImage;
}

/**
 * Uploads per update(). Each one is a texStorage2D, a texSubImage2D and a
 * mipmap generation, about 1-3 ms for a 512 px tile on a phone, where
 * UPLOAD_BUDGET_MS lets two or three go per frame. Tiles from the HTTP cache
 * land in a burst, and on a desktop each upload is a fraction of a ms, so
 * this cap is what paces them: eight a frame puts a 76-tile view up in ten
 * frames rather than 26. It also bounds the texture data handed to the GPU
 * in one frame, which the main-thread clock does not see; a phone, where the
 * GPU's share of that is largest, is held to fewer (`maxUploadsPerUpdate`).
 */
const MAX_UPLOADS_PER_UPDATE = 8;
/** Stop uploading for this update once this much time has gone. */
const UPLOAD_BUDGET_MS = 4;
/**
 * How long a tile may stay out of the view before its download is aborted (or
 * its decoded bitmap dropped), in ms: just under ten frames at 60 Hz. A tile
 * one pixel outside the frustum for a frame of a pan would otherwise be
 * cancelled mid-download and fetched again when it comes back. Time, not
 * frames, because frames stop when the view does: counted in frames, a fetch
 * left behind by the last pan would never age out.
 */
const ABORT_GRACE_MS = 160;
/** Candidates at the head of each frame's queue fetched at high priority. */
const HIGH_PRIORITY_CANDIDATES = 4;
/**
 * Rounds of maxConcurrent requests the tiles nearest the view centre get
 * before any coarse fallback for the rest of the view: three cover the
 * centre quarter of a 76-tile laptop view. See update().
 */
const LEAD_ROUNDS = 3;
/** Rounds of edge tiles, beyond the lead, that make a fallback worth it. */
const FALLBACK_ROUNDS = 2;

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

/** Floats per tile in a LevelTable: bounding sphere, then unit centre direction. */
const STRIDE = 7;
/** Bounding spheres are padded slightly so a tile at the frustum edge is kept. */
const CULL_PAD = 1.05;

/**
 * Everything update() needs about one pyramid level, computed once per page
 * the first time that level is wanted (see levelTable), so the per-frame cull is plain
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

// Scratch for buildLevelTable: one cube point, and the four corners' xyz.
const cornerDir: Vec3 = { x: 0, y: 0, z: 0 };
const cornerPos = new Float64Array(12);

function buildLevelTable(level: number): LevelTable {
  const g = tilesPerEdge(level);
  const count = FACES.length * g * g;
  const data = new Float32Array(count * STRIDE);
  const keys = new Array<string>(count);
  const p = cornerPos;
  const d = cornerDir;
  for (let f = 0; f < FACES.length; f++) {
    const face = FACES[f]!;
    for (let y = 0; y < g; y++) {
      for (let x = 0; x < g; x++) {
        const i = (f * g + y) * g + x;
        // Corners on the flat cube face, where the quad is drawn
        // (tile-geometry.ts), not on the sphere: TL, TR, BL, BR, as
        // tileCornersUV orders them.
        const u0 = x / g;
        const v0 = y / g;
        const u1 = (x + 1) / g;
        const v1 = (y + 1) / g;
        for (let c = 0; c < 4; c++) {
          faceUVInto(d, face, c & 1 ? u1 : u0, c & 2 ? v1 : v0);
          p[c * 3] = d.x * RADIUS;
          p[c * 3 + 1] = d.y * RADIUS;
          p[c * 3 + 2] = d.z * RADIUS;
        }
        const cx = (p[0]! + p[3]! + p[6]! + p[9]!) / 4;
        const cy = (p[1]! + p[4]! + p[7]! + p[10]!) / 4;
        const cz = (p[2]! + p[5]! + p[8]! + p[11]!) / 4;
        let r = 0;
        for (let c = 0; c < 12; c += 3) {
          r = Math.max(r, Math.hypot(p[c]! - cx, p[c + 1]! - cy, p[c + 2]! - cz));
        }
        faceUVInto(d, face, (u0 + u1) / 2, (v0 + v1) / 2);
        const mlen = Math.hypot(d.x, d.y, d.z) || 1;
        const o = i * STRIDE;
        data[o] = cx;
        data[o + 1] = cy;
        data[o + 2] = cz;
        data[o + 3] = r * CULL_PAD;
        data[o + 4] = d.x / mlen;
        data[o + 5] = d.y / mlen;
        data[o + 6] = d.z / mlen;
        keys[i] = tileKey(level, face, x, y);
      }
    }
  }
  return { g, data, keys };
}

/**
 * Level tables by level, shared by every layer on the page. A table depends
 * on the level alone (not the source, nor its tile size), so a scene change
 * reuses the ones already built instead of spending up to a few ms per level
 * rebuilding them.
 */
const levelTables: (LevelTable | undefined)[] = [];

function levelTable(level: number): LevelTable {
  let t = levelTables[level];
  if (!t) {
    t = buildLevelTable(level);
    levelTables[level] = t;
  }
  return t;
}

/** Candidate order: nearest the view centre first. */
const byPriority = (a: Candidate, b: Candidate): number => a.priority - b.priority;

export class TileLayer {
  private cache = new Map<string, TileEntry>();
  private inflight = new Map<string, AbortController>();
  // Decoded and not yet uploaded, in arrival order. See drainReady().
  private ready = new Map<string, ReadyTile>();
  // When an in-flight or decoded tile stopped being wanted, on the layer's clock.
  private stale = new Map<string, number>();
  // `${level}/` for every level, the start of that level's keys.
  private levelPrefix: string[];
  // Parents already queued this frame, so siblings queue one between them.
  // A sibling that needs it sooner moves it up.
  private parentsQueued = new Map<string, Candidate>();
  private queue: Candidate[] = [];
  // Next queue index pump() takes. A cursor rather than shift(), which is
  // O(n) per dequeue; update() replaces the queue and resets it every frame.
  private queueHead = 0;
  private clock = 0;
  private maxTiles: number;
  private maxConcurrent: number;
  private maxUploads: number;
  // The tolerance selectLevel gets: the viewer's own plus the host's lodBias.
  private lodTolerance: number;
  private now: () => number;
  private sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private network: TileNetwork;
  private disposed = false;
  // Set while the viewer is off screen: no new requests start.
  private paused = false;
  // Aborted by dispose(). Only the base loader's retry wait listens to it: the
  // in-flight fetches are cancelled through their own controllers in `inflight`.
  private lifetime = new AbortController();
  // The one wake timer: fires onInvalidate when a failed tile's cooldown ends,
  // so an idle viewer retries it without waiting for an interaction, or when
  // a load left out of view has had its grace and can be aborted. `wakeAt` is
  // when it fires, on the layer's clock, so an earlier need can replace a
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
  // What evict() is removing this frame.
  private evicting: TileEntry[] = [];
  // What queueParent() returns, reused.
  private parentResult = { present: false, wait: Infinity };
  // Tile indices at `visibleLevel` that passed the cull, `visibleCount` long.
  private visible: Int32Array;
  private visibleCount = 0;
  private visibleLevel = -1;
  // Every tile the cull reached, level 0 down to `visibleLevel`, in the order
  // it reached them (each tile before its children): `treeCount` long. What
  // cover() walks to find the coarse tiles that finer ones hide.
  private treeLevel = new Uint8Array(64);
  private treeIndex = new Int32Array(64);
  private treeCount = 0;
  // cover()'s position in the tree.
  private treeAt = 0;
  // The view the cull last ran for. An unchanged view and level reuse the
  // visible set: a tile landing asks for a frame but moves nothing.
  private lastViewProj = new Float32Array(16);
  // The priority of the last of the LEAD_ROUNDS × maxConcurrent tiles in
  // view nearest its centre, resident or not; Infinity when the view holds no
  // more than that. A target at or under it is one of the first rounds.
  private leadCutoff = Infinity;
  // Scratch for the cutoff: every visible tile's priority.
  private ranks = new Float32Array(64);
  // In-view tiles two levels above the target (from level 3), which a large
  // view fetches as the coarse fallback. Loads of them are kept, like the
  // level just above the target's.
  private fallbackInView = new Set<string>();

  constructor(
    private renderer: GLRenderer,
    /** Read by the viewer too: the source this layer draws. */
    readonly source: CubeTileSource,
    private onInvalidate: () => void,
    opts: TileLayerOptions,
  ) {
    this.maxTiles = maxTilesForBudget(opts.textureBudgetMB, source.tileSize, opts.minResidentTiles);
    this.maxConcurrent = opts.maxConcurrent;
    this.maxUploads = opts.maxUploadsPerUpdate ?? MAX_UPLOADS_PER_UPDATE;
    this.lodTolerance = LOD_TOLERANCE + opts.lodBias;
    this.now = opts.now ?? (() => performance.now());
    this.sleep = opts.sleep ?? defaultSleep;
    this.network = opts.network ?? {};
    // Cooldowns and the wake timer share one clock (faked together in tests).
    this.retry = new TileRetryBudget(opts.retry, this.now);
    this.visible = new Int32Array(FACES.length * tilesPerEdge(source.maxLevel) ** 2);
    this.levelPrefix = Array.from({ length: source.maxLevel + 1 }, (_, l) => `${l}/`);
  }

  /**
   * Load the low-resolution base layer: the six level-0 tiles, which are
   * exactly one tile per cube face and therefore a complete, if soft, copy of
   * the whole panorama.
   *
   * Blocking and fatal by design. Once these six are resident every direction
   * has *some* texture, `pickEvictions()` pins them against LRU eviction, and
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
      const result = await this.ensureTile(0, face, 0, 0, 'high');
      if (result.kind === 'loaded') return;
      // Disposal (or a newer load superseding this one) tears the layer down
      // mid-flight. That is not the base layer failing — the caller already
      // discards this load — so it resolves quietly rather than reporting an
      // error nobody is waiting for.
      if (this.disposed) return;
      // The tile is fine, but no texture can be made until the context is
      // restored, and the viewer replaces this layer then. Failing the load
      // would report a fault that is not there.
      if (result.kind === 'lost') {
        await untilAborted(this.lifetime.signal);
        return;
      }
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
    throw new BaseTileLoadError(this.source.id, face, cause);
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
      this.source.tileSize,
      this.source.maxLevel,
      this.lodTolerance,
    );
    if (level !== this.visibleLevel || !sameMatrix(viewProj, this.lastViewProj)) {
      this.lastViewProj.set(viewProj);
      frustumFromViewProj(viewProj, this.frustum);
      this.cull(level);
      this.desired.clear();
      const { keys } = this.table(level);
      for (let n = 0; n < this.visibleCount; n++) this.desired.add(keys[this.visible[n]!]!);
      this.rankView(level, fwd);
    }

    const now = this.now();
    this.drainReady(level, now);

    // The candidates are rebuilt even for a still view: a tile that landed,
    // failed or finished its cooldown since the last frame changes them.
    this.candidates.length = 0;
    this.parentsQueued.clear();
    // Soonest the layer needs a frame with nothing else asking for one: a
    // wanted tile's retry cooldown ending, or a stale load's grace running out.
    let wakeMs = Infinity;
    // Targets still to request beyond the first rounds: the edges of the view.
    let edge = 0;
    const { g, data, keys } = this.table(level);
    for (let n = 0; n < this.visibleCount; n++) {
      const i = this.visible[n]!;
      const key = keys[i]!;
      const entry = this.cache.get(key);
      if (entry) {
        // Cached and still wanted — refresh LRU stamp so eviction reflects
        // actual visibility, not upload/insertion order.
        entry.lastUsed = this.clock;
        continue;
      }
      if (this.ready.has(key)) continue; // goes up within a few frames
      if (this.inflight.has(key)) continue; // on its way
      if (this.retry.eligible(key)) {
        const o = i * STRIDE;
        // Smaller = closer to the view centre.
        const priority = 1 - (data[o + 4]! * fwd.x + data[o + 5]! * fwd.y + data[o + 6]! * fwd.z);
        const f = Math.floor(i / (g * g));
        const rest = i - f * g * g;
        this.pushCandidate(key, level, FACES[f]!, rest % g, Math.floor(rest / g), priority);
        if (priority > this.leadCutoff) edge++;
      } else {
        wakeMs = Math.min(wakeMs, this.retry.waitMs(key));
      }
    }

    // A large view on a slow link takes many rounds of requests, and its
    // edges would sit on the base (an eighth of the detail at level 3) until
    // the last one. So when more than FALLBACK_ROUNDS rounds of edge tiles are
    // still to request, each gets a coarse fallback: its grandparent from
    // level 3 (one request covers up to sixteen of them), its parent at level
    // 2. The fallbacks queue behind the first LEAD_ROUNDS rounds of tiles
    // nearest the centre, and ahead of the edge tiles. Those first rounds are
    // ranked against the whole view (leadCutoff), not against what is still
    // queued: the queue is rebuilt every frame, and a rank taken from it would
    // put the next round of centre tiles ahead of the fallbacks forever.
    const fallback = edge > FALLBACK_ROUNDS * this.maxConcurrent;
    if (fallback) {
      // Targets: [0, 2] within the first rounds, [4, 6] after; fallbacks
      // take [2, 4] in between, centre-first among themselves.
      for (const c of this.candidates) if (c.priority > this.leadCutoff) c.priority += 4;
    }

    // A missing tile's parent is what shows in its place: a resident one is
    // kept, and a missing one is fetched for a tile that cannot be fetched
    // itself right now (cooling down after a failure, or failed for good),
    // ahead of everything else. Beyond that, parents are fetched only as the
    // fallback above. Otherwise a parent would only queue ahead of its
    // children and hold the target level back a round; the view shows the
    // nearest resident ancestor (the base at worst) until the children land.
    if (level >= 2) {
      for (let n = 0; n < this.visibleCount; n++) {
        const i = this.visible[n]!;
        const key = keys[i]!;
        if (this.cache.has(key)) continue;
        const o = i * STRIDE;
        const priority = 1 - (data[o + 4]! * fwd.x + data[o + 5]! * fwd.y + data[o + 6]! * fwd.z);
        const f = Math.floor(i / (g * g));
        const rest = i - f * g * g;
        const x = rest % g;
        const y = Math.floor(rest / g);
        const started = this.ready.has(key) || this.inflight.has(key);
        const eligible = this.retry.eligible(key);
        // Centre-first priorities are 1 - cos, in [0, 2]: minus 2 sorts every
        // such parent before every target-level tile.
        const fetchParent = !started && !eligible;
        const parent = this.queueParent(f, level - 1, x >> 1, y >> 1, priority - 2, fetchParent);
        wakeMs = Math.min(wakeMs, parent.wait);
        if (!fallback || started || !eligible || priority <= this.leadCutoff) continue;
        if (level === 2) {
          wakeMs = Math.min(
            wakeMs,
            this.queueParent(f, 1, x >> 1, y >> 1, priority + 2, true).wait,
          );
        } else if (!parent.present) {
          wakeMs = Math.min(
            wakeMs,
            this.queueParent(f, level - 2, x >> 2, y >> 2, priority + 2, true).wait,
          );
        }
      }
    }

    // Abort in-flight loads that have been out of the view for
    // ABORT_GRACE_MS. See wanted() for what is kept.
    for (const [key, controller] of this.inflight) {
      if (this.wanted(key, level)) {
        this.stale.delete(key);
        continue;
      }
      const age = this.unwantedFor(key, now);
      if (age >= ABORT_GRACE_MS) {
        controller.abort();
        this.inflight.delete(key);
        this.stale.delete(key);
      } else {
        // Frames stop when the view does, so the abort needs its own wake.
        wakeMs = Math.min(wakeMs, ABORT_GRACE_MS - age);
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
    // through: every *coarser* resident tile stays visible and drawList()
    // emits them all. The renderer draws finest-first with each level at its
    // own depth, finer in front (see render() in render/gl-renderer.ts), so a
    // coarser tile only shows where no finer tile covers it, and a finer tile
    // that is absent simply leaves its ancestor's texels on screen. loadBase()
    // guarantees the level-0 ancestor is resident and pickEvictions() never
    // evicts it, so that floor always exists. cover() then leaves out the
    // coarser tiles nothing of which would show.
    for (const entry of this.cache.values()) {
      entry.visible = entry.level <= level;
    }

    this.evict();
    this.cover();
    this.pump();
    // Frames only run when something is dirty, so a hole waiting out a retry
    // cooldown, or a stale load waiting out its grace, on a still view needs
    // its own wake.
    this.armWake(wakeMs);
  }

  /**
   * Every resident tile at or below the target level, less those finer
   * resident tiles hide (see cover()); the renderer orders them.
   */
  drawList(): DrawItem[] {
    this._drawList.length = 0;
    for (const entry of this.cache.values()) {
      if (entry.visible) {
        this._drawList.push(entry.item);
      }
    }
    return this._drawList;
  }

  /**
   * Hold (or release) the queue: while paused, no new request starts, and the
   * ones in flight finish. For a viewer scrolled off screen, whose frames
   * have stopped but whose finishing loads would otherwise keep pumping.
   */
  setPaused(paused: boolean): void {
    if (this.paused === paused) return;
    this.paused = paused;
    this.pump();
  }

  private pump(): void {
    // ensureTile()'s `finally` pumps unconditionally, and dispose() aborts
    // every in-flight fetch at once — so without this guard a disposal frees
    // maxConcurrent slots and drains whatever update() last queued into a
    // fresh round of fetches that are downloaded and decoded only to be
    // discarded.
    if (this.disposed || this.paused) return;
    while (this.inflight.size < this.maxConcurrent && this.queueHead < this.queue.length) {
      const next = this.queue[this.queueHead++]!;
      if (this.cache.has(next.key) || this.inflight.has(next.key) || this.ready.has(next.key)) {
        continue;
      }
      // The head of the queue is what the view is centred on (or the parents
      // it needs first); the rest can wait behind other requests.
      const priority = this.queueHead <= HIGH_PRIORITY_CANDIDATES ? 'high' : 'low';
      void this.ensureTile(next.level, next.face, next.x, next.y, priority);
    }
  }

  /**
   * Keep a resident ancestor of a missing tile, and with `fetch`, queue a
   * missing one at `priority`: it fills the hole at a coarser level than the
   * target but finer than the base. `present` is whether the ancestor is
   * resident, in flight or decoded; `wait` how long until one cooling down
   * after a failure may go again, Infinity when there is nothing to wait for.
   */
  private queueParent(
    f: number,
    level: number,
    x: number,
    y: number,
    priority: number,
    fetch: boolean,
  ): { present: boolean; wait: number } {
    const t = this.table(level);
    const key = t.keys[(f * t.g + y) * t.g + x]!;
    const result = this.parentResult;
    result.present = true;
    result.wait = Infinity;
    const entry = this.cache.get(key);
    if (entry) {
      // On screen as the fallback for its missing child: not to be evicted.
      entry.lastUsed = this.clock;
      return result;
    }
    if (this.inflight.has(key) || this.ready.has(key)) return result;
    result.present = false;
    if (!fetch) return result;
    const queued = this.parentsQueued.get(key);
    if (queued) {
      queued.priority = Math.min(queued.priority, priority);
      return result;
    }
    if (!this.retry.eligible(key)) {
      result.wait = this.retry.waitMs(key);
      return result;
    }
    this.parentsQueued.set(key, this.pushCandidate(key, level, FACES[f]!, x, y, priority));
    return result;
  }

  /**
   * After a cull: the leadCutoff for the new view, and the in-view tiles at
   * the grandparent level, whose loads are kept (see wanted()).
   */
  private rankView(level: number, fwd: { x: number; y: number; z: number }): void {
    const lead = LEAD_ROUNDS * this.maxConcurrent;
    this.leadCutoff = Infinity;
    if (this.visibleCount > lead) {
      if (this.ranks.length < this.visibleCount) this.ranks = new Float32Array(this.visible.length);
      const { data } = this.table(level);
      for (let n = 0; n < this.visibleCount; n++) {
        const o = this.visible[n]! * STRIDE;
        this.ranks[n] = 1 - (data[o + 4]! * fwd.x + data[o + 5]! * fwd.y + data[o + 6]! * fwd.z);
      }
      const ranked = this.ranks.subarray(0, this.visibleCount).sort();
      this.leadCutoff = ranked[lead - 1]!;
    }
    this.fallbackInView.clear();
    if (level >= 3) {
      const { keys } = this.table(level - 2);
      for (let n = 0; n < this.treeCount; n++) {
        if (this.treeLevel[n] === level - 2) this.fallbackInView.add(keys[this.treeIndex[n]!]!);
      }
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
    return levelTable(level);
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
    this.treeCount = 0;
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
    this.addTreeNode(level, o / STRIDE);
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

  private addTreeNode(level: number, index: number): void {
    if (this.treeCount === this.treeIndex.length) {
      const size = this.treeCount * 2;
      const levels = new Uint8Array(size);
      const indices = new Int32Array(size);
      levels.set(this.treeLevel);
      indices.set(this.treeIndex);
      this.treeLevel = levels;
      this.treeIndex = indices;
    }
    this.treeLevel[this.treeCount] = level;
    this.treeIndex[this.treeCount++] = index;
  }

  /**
   * Leave out of the draw list every coarse tile that finer resident tiles
   * hide wherever it is in view. The renderer draws the finest level in front,
   * so such a tile only costs draw calls: the picture is the same without it.
   *
   * Walks the tree the cull built: a tile in view is filled when it is
   * resident, or when every child of it in view is filled. A resident tile
   * above the target level whose children in view are all filled is hidden.
   * Children outside the view do not count; the renderer would cull them, and
   * the parent's part over them is off screen too. Only uploaded tiles count
   * (a decoded one waiting in the ready queue is not in the cache), and this
   * runs after eviction, so a child just evicted brings its parent back the
   * same frame.
   *
   * The level-0 base is always drawn: it is the floor under every seam, so a
   * pixel the finer quads' edges leave uncovered still shows the panorama.
   */
  private cover(): void {
    this.treeAt = 0;
    while (this.treeAt < this.treeCount) this.coverNode();
  }

  /** Whether the tree node at treeAt is filled; moves treeAt past its subtree. */
  private coverNode(): boolean {
    const n = this.treeAt++;
    const level = this.treeLevel[n]!;
    const entry = this.cache.get(levelTable(level).keys[this.treeIndex[n]!]!);
    if (level === this.visibleLevel) return entry !== undefined;
    let filled = true;
    // The children follow their parent, each with its own subtree after it.
    while (this.treeAt < this.treeCount && this.treeLevel[this.treeAt] === level + 1) {
      if (!this.coverNode()) filled = false;
    }
    if (!entry) return filled;
    if (filled && level > 0) entry.visible = false;
    return true;
  }

  private pushCandidate(
    key: string,
    level: number,
    face: Face,
    x: number,
    y: number,
    priority: number,
  ): Candidate {
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
    return c;
  }

  private async ensureTile(
    level: number,
    face: Face,
    x: number,
    y: number,
    priority: RequestPriority,
  ): Promise<TileLoadOutcome> {
    if (this.disposed) return { kind: 'aborted' };
    const key = tileKey(level, face, x, y);
    if (this.cache.has(key)) return { kind: 'loaded' };
    if (this.inflight.has(key) || this.ready.has(key)) return { kind: 'skipped' };
    const controller = new AbortController();
    this.inflight.set(key, controller);
    try {
      // `priority` is a hint; browsers without it ignore the field.
      const bitmap = await loadTileImage(
        this.source,
        { face, level, x, y },
        controller.signal,
        priority,
        this.network,
      );
      // createImageBitmap ignores the signal (and a source's loadTile may
      // too), so an abort during the decode shows up only here. The slot and
      // the key have moved on (a reload may own the key now), so this bitmap
      // must not join the queue.
      if (this.disposed || controller.signal.aborted) {
        releaseImage(bitmap);
        return { kind: 'aborted' };
      }
      // An earlier load of this key can finish first: update() aborts a tile
      // that leaves the view, but createImageBitmap ignores the signal, so a
      // load aborted mid-decode still lands — after a reload has started. The
      // second one to land must not upload over the first, or the first
      // texture is never freed.
      if (this.cache.has(key) || this.ready.has(key)) {
        releaseImage(bitmap);
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
      // Not the tile's fault either: it loads again once the context is back.
      if (err instanceof ContextLostError) return { kind: 'lost' };
      const failure = this.recordFailure(key, err);
      return { kind: 'failed', failure, error: err };
    } finally {
      // Only clear the slot this call owns. After an abort the key may already
      // belong to a reload, which must stay tracked: it still counts against
      // maxConcurrent and update() must still be able to abort it.
      if (this.inflight.get(key) === controller) this.inflight.delete(key);
      if (!this.inflight.has(key) && !this.ready.has(key)) this.stale.delete(key);
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
    bitmap: TileImage,
  ): void {
    const geom = buildTileGeometry(face, level, x, y);
    let handle: TileHandle;
    try {
      handle = this.renderer.uploadTile(geom, bitmap);
    } finally {
      // The GPU texture owns the pixels now (or the upload failed, e.g. on a
      // lost context): free the CPU copy either way.
      releaseImage(bitmap);
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

  /**
   * Is a tile that is loading still worth finishing at `level`? Yes if it is
   * in view, if it is level 0 (the base loadBase() is waiting on, pinned and
   * drawn at every level once resident), or if it is one level coarser than
   * the target: after a zoom-in step those still improve on the fallback
   * until the finer tiles land. So is one in view two levels coarser than a
   * target of 3 or more: the fallback a large view fetches.
   */
  private wanted(key: string, level: number): boolean {
    return (
      this.desired.has(key) ||
      key.startsWith('0/') ||
      (level > 0 && key.startsWith(this.levelPrefix[level - 1]!)) ||
      this.fallbackInView.has(key)
    );
  }

  /** How long `key` has been unwanted, counting from now if it just stopped being wanted. */
  private unwantedFor(key: string, now: number): number {
    let since = this.stale.get(key);
    if (since === undefined) {
      since = now;
      this.stale.set(key, since);
    }
    return now - since;
  }

  private recordFailure(key: string, err: unknown): FailureKind {
    const failure = classifyFailure(err);
    this.retry.recordFailure(key, failure);
    // Still on screen: come back for it when its cooldown ends, even if
    // nothing else asks for a frame before then.
    const wait = this.retry.waitMs(key);
    if (this.desired.has(key)) this.armWake(wait);
    // Never coming back (permanent, or out of attempts): the tile has stopped
    // being pending, which may be what settles the view. Ask for a frame so
    // hasPending() is read again, or tiles-settled waits for the next input.
    if (!Number.isFinite(wait)) this.onInvalidate();
    return failure;
  }

  /**
   * Upload what has decoded since the last frame: at most
   * maxUploads, and none once UPLOAD_BUDGET_MS has gone, so a
   * burst of decodes is spread over several frames instead of one long one.
   * A tile out of the view waits without uploading, and once it has been out
   * for ABORT_GRACE_MS it is dropped and its bitmap closed. Anything left
   * over asks for another frame.
   */
  private drainReady(level: number, start: number): void {
    if (this.ready.size === 0) return;
    let uploads = 0;
    for (const [key, tile] of this.ready) {
      if (this.wanted(key, level)) {
        this.stale.delete(key);
      } else {
        if (this.unwantedFor(key, start) >= ABORT_GRACE_MS) {
          releaseImage(tile.bitmap);
          this.ready.delete(key);
          this.stale.delete(key);
        }
        continue;
      }
      if (uploads >= this.maxUploads || this.now() - start >= UPLOAD_BUDGET_MS) continue;
      this.ready.delete(key);
      uploads++;
      try {
        this.upload(key, tile.level, tile.face, tile.x, tile.y, tile.bitmap);
      } catch (err) {
        // A lost context is no fault of the tile's: it spends no attempt.
        if (!(err instanceof ContextLostError)) this.recordFailure(key, err);
      }
    }
    if (this.ready.size > 0) this.onInvalidate();
  }

  private evict(): void {
    // pickEvictions() keeps every tile on screen and the six base tiles
    // whatever the budget, so the cache may overshoot up to that many. Inside
    // that bound there is nothing to do: skip the O(cacheSize) scan, which a
    // view wider than the budget would otherwise run every frame for nothing.
    if (this.cache.size <= Math.max(this.maxTiles, this.desired.size + FACES.length)) return;
    const evicting = pickEvictions(
      this.cache.values(),
      this.cache.size - this.maxTiles,
      this.clock,
      this.evicting,
    );
    for (const e of evicting) {
      this.renderer.removeTile(e.handle);
      this.cache.delete(e.key);
    }
    if (evicting.length > 0) {
      evicting.length = 0;
      this.onInvalidate();
    }
  }

  /**
   * Is any tile for the current view still to come? Queued, in flight or
   * decoded and waiting to be uploaded. The queue is non-empty after pump()
   * only when every slot is busy, and a held queue is work that has not
   * happened yet, not work that is done. Tiles that are only finishing after
   * leaving the view (see ABORT_GRACE_MS) do not count, and neither does
   * a tile that failed: it is out of the queue while it waits out a per-tile
   * cooldown, and for good once it is permanent or out of attempts.
   */
  hasPending(): boolean {
    if (this.queueHead < this.queue.length) return true;
    for (const key of this.inflight.keys()) {
      // The base counts before the first frame has said what is in view.
      if (this.desired.has(key) || key.startsWith('0/')) return true;
    }
    for (const key of this.ready.keys()) if (this.desired.has(key)) return true;
    return false;
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
    this.treeCount = 0;
    for (const c of this.inflight.values()) c.abort();
    this.inflight.clear();
    for (const tile of this.ready.values()) releaseImage(tile.bitmap);
    this.ready.clear();
    this.stale.clear();
    this.parentsQueued.clear();
    this.fallbackInView.clear();
    for (const e of this.cache.values()) {
      this.renderer.removeTile(e.handle);
    }
    this.cache.clear();
    this.retry.clear();
  }
}
