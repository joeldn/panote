import {
  configKey,
  manifestKey,
  panoPrefix,
  tourKey,
  userToursPrefix,
  type PanoManifestSummary,
  type PanoSummary,
  type SceneConfig,
  type TilingStatus,
  type TourDoc,
  type TourSummary,
} from '@internal/contracts';
import { getJson } from '@internal/worker-kit/r2-binding';

// Same order the plan's tiling rule checks in: ready beats failed beats
// pending, so a same-etag race never reports a tiled pano as failed.
const TILE_VERSION_ETAG_RE = /^t\d+-(.+)$/;

export const computeTilingStatus = (params: {
  hasManifest: boolean;
  manifestVersion: string | undefined;
  originalEtag: string | undefined;
  tileFailedOriginalEtag: string | undefined;
}): TilingStatus => {
  const { hasManifest, manifestVersion, originalEtag, tileFailedOriginalEtag } = params;
  const capturedEtag = manifestVersion
    ? TILE_VERSION_ETAG_RE.exec(manifestVersion)?.[1]
    : undefined;
  if (hasManifest && originalEtag !== undefined && capturedEtag === originalEtag) return 'ready';
  if (
    tileFailedOriginalEtag !== undefined &&
    originalEtag !== undefined &&
    tileFailedOriginalEtag === originalEtag
  ) {
    return 'failed';
  }
  if (originalEtag !== undefined) return 'pending';
  return 'none';
};

export type TourFields = { title: string; sceneCount: number; coverPanoId: string | null };

// Prefers customMetadata (no extra read); falls back to one legacy read for
// a tour.json written before this unit started stamping metadata.
export const resolveTourFields = async (
  meta: Record<string, string> | undefined,
  legacyRead: () => Promise<TourDoc | null>,
): Promise<TourFields> => {
  if (meta?.title !== undefined && meta.sceneCount !== undefined) {
    return {
      title: meta.title,
      sceneCount: Number(meta.sceneCount),
      coverPanoId: meta.coverPanoId ? meta.coverPanoId : null,
    };
  }
  const doc = await legacyRead();
  return {
    title: doc?.title ?? '',
    sceneCount: doc?.scenes.length ?? 0,
    coverPanoId: doc?.scenes[0]?.panoId ?? null,
  };
};

// Same idea as resolveTourFields, for the single `title` field a pano's
// config.json carries.
export const resolvePanoTitle = async (
  meta: Record<string, string> | undefined,
  legacyRead: () => Promise<SceneConfig | null>,
): Promise<string | null> => {
  if (meta?.title !== undefined) return meta.title;
  const doc = await legacyRead();
  return doc?.title ?? null;
};

// A publish.json's customMetadata (unit B2 writes it; nothing does yet, so
// this always returns null until then, per the plan's forward-compat note).
const toPublishSummary = (
  meta: Record<string, string> | undefined,
): { slug: string; visibility: 'public' | 'unlisted' } | null => {
  if (!meta?.slug) return null;
  if (meta.visibility !== 'public' && meta.visibility !== 'unlisted') return null;
  return { slug: meta.slug, visibility: meta.visibility };
};

// R2 customMetadata is capped at 8192 bytes (error 10012 past that); B1
// doesn't cap title length. Cap is in UTF-16 units (String#length's unit).
const METADATA_TITLE_MAX_UNITS = 256;
const HIGH_SURROGATE_MIN = 0xd800;
const HIGH_SURROGATE_MAX = 0xdbff;

const truncateForMetadata = (title: string): string => {
  const sliced = title.slice(0, METADATA_TITLE_MAX_UNITS);
  const lastCode = sliced.charCodeAt(sliced.length - 1);
  // A lone trailing high surrogate means the slice split a surrogate pair
  // (e.g. an emoji) in half; drop it rather than emit invalid UTF-16.
  const splitSurrogate = lastCode >= HIGH_SURROGATE_MIN && lastCode <= HIGH_SURROGATE_MAX;
  return splitSurrogate ? sliced.slice(0, -1) : sliced;
};

export const tourCustomMetadata = (tour: TourDoc): Record<string, string> => ({
  title: truncateForMetadata(tour.title),
  sceneCount: String(tour.scenes.length),
  coverPanoId: tour.scenes[0]?.panoId ?? '',
});

export const configCustomMetadata = (config: SceneConfig): Record<string, string> => ({
  title: truncateForMetadata(config.title),
});

export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 100;

export type ParsedLimit = { ok: true; limit: number } | { ok: false };

// Absent keeps the default; anything present must be an integer in
// [1, MAX_LIST_LIMIT] or the route 400s rather than silently clamping/guessing.
export const parseListLimit = (raw: string | undefined): ParsedLimit => {
  if (raw === undefined) return { ok: true, limit: DEFAULT_LIST_LIMIT };
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > MAX_LIST_LIMIT) return { ok: false };
  return { ok: true, limit: n };
};

// True keyset pagination: resumes from the first id strictly greater than
// the cursor, so a since-deleted cursor pano can't restart or loop the list.
export const paginateIds = (
  sorted: readonly string[],
  cursor: string | undefined,
  limit: number,
): { page: string[]; cursor: string | null } => {
  if (cursor !== undefined) {
    const startIndex = sorted.findIndex((id) => id > cursor);
    if (startIndex === -1) return { page: [], cursor: null };
    const page = sorted.slice(startIndex, startIndex + limit);
    const hasMore = startIndex + page.length < sorted.length;
    return { page, cursor: hasMore ? (page[page.length - 1] ?? null) : null };
  }
  const page = sorted.slice(0, limit);
  const hasMore = page.length < sorted.length;
  return { page, cursor: hasMore ? (page[page.length - 1] ?? null) : null };
};

const filenameAfter = (key: string, prefix: string): string => key.slice(prefix.length);

// Reads the one prefix list() the plan budgets for readiness, plus (only
// with ownership proof) the manifest get() - no other read when metadata is present.
export const summarizePano = async (
  bucket: R2Bucket,
  sub: string,
  panoId: string,
): Promise<Omit<PanoSummary, 'panoId'>> => {
  const prefix = panoPrefix(sub, panoId);
  const listed = await bucket.list({ prefix, include: ['customMetadata'] });
  let configObj: R2Object | undefined;
  let originalObj: R2Object | undefined;
  let deletingObj: R2Object | undefined;
  let tileFailedObj: R2Object | undefined;
  for (const obj of listed.objects) {
    const rest = filenameAfter(obj.key, prefix);
    if (rest === 'config.json') configObj = obj;
    else if (rest === 'original') originalObj = obj;
    else if (rest === 'deleting') deletingObj = obj;
    else if (rest === 'tile-failed') tileFailedObj = obj;
  }

  // Security: the manifest key is owner-free, so it's only read with proof
  // of ownership (originalObj) - else any caller could probe another owner's tiling state.
  const manifestObj = originalObj ? await bucket.get(manifestKey(panoId)) : null;
  const manifestBody = manifestObj
    ? await manifestObj.json<{ version?: string; format?: string; tileSize?: number }>()
    : null;

  const tiling = computeTilingStatus({
    hasManifest: !!manifestObj,
    manifestVersion: manifestBody?.version,
    originalEtag: originalObj?.etag,
    tileFailedOriginalEtag: tileFailedObj?.customMetadata?.originalEtag,
  });

  const title = await resolvePanoTitle(configObj?.customMetadata, async () =>
    configObj
      ? ((await getJson<SceneConfig>(bucket, configKey(sub, panoId)))?.value ?? null)
      : null,
  );

  const updatedAtSource = configObj ?? originalObj ?? deletingObj ?? tileFailedObj;
  return {
    title,
    hasConfig: !!configObj,
    hasOriginal: !!originalObj,
    deleting: !!deletingObj,
    tiling,
    // Only the 3 summary fields, not the whole manifest; trusts our own
    // tiler output the same way tiler-consumer's own reads do (no re-validation).
    manifest: manifestBody
      ? ({
          version: manifestBody.version,
          format: manifestBody.format,
          tileSize: manifestBody.tileSize,
        } as PanoManifestSummary)
      : null,
    updatedAt: (updatedAtSource?.uploaded ?? new Date(0)).toISOString(),
  };
};

export const PANO_SUMMARY_CONCURRENCY = 8;

export const listPanoSummaries = async (
  bucket: R2Bucket,
  sub: string,
  panoIds: readonly string[],
  cursor: string | undefined,
  limit: number,
): Promise<{ panos: PanoSummary[]; cursor: string | null }> => {
  const sorted = [...panoIds].sort();
  const { page, cursor: nextCursor } = paginateIds(sorted, cursor, limit);
  const panos: PanoSummary[] = new Array(page.length);
  for (let i = 0; i < page.length; i += PANO_SUMMARY_CONCURRENCY) {
    const batch = page.slice(i, i + PANO_SUMMARY_CONCURRENCY);
    const results = await Promise.all(batch.map((panoId) => summarizePano(bucket, sub, panoId)));
    results.forEach((r, j) => {
      panos[i + j] = { panoId: batch[j] as string, ...r };
    });
  }
  return { panos, cursor: nextCursor };
};

type TourGroup = { tourObj?: R2Object; publishObj?: R2Object };

// Groups tour.json + publish.json by tourId from list() batches (per the
// plan); publish.json is unwritten until B2, so publish is null until then.
export const listTourSummaries = async (
  bucket: R2Bucket,
  sub: string,
  cursor: string | undefined,
  limit: number,
): Promise<{ tours: TourSummary[]; cursor: string | null }> => {
  const prefix = userToursPrefix(sub);
  const groups = new Map<string, TourGroup>();
  const orderedTourIds: string[] = [];
  let completeCount = 0;
  let r2Cursor: string | undefined;
  const startAfter = cursor !== undefined ? tourKey(sub, cursor) : undefined;
  let isFirstFetch = true;

  // Keyset over tourIds, not raw R2 objects, so a page never splits a tour's
  // tour.json from its publish.json; fetches one extra tour as a next-page lookahead.
  while (completeCount <= limit) {
    const batchSize = (limit + 1) * 2;
    const listed = await bucket.list({
      prefix,
      include: ['customMetadata'],
      limit: batchSize,
      ...(isFirstFetch && startAfter ? { startAfter } : {}),
      ...(!isFirstFetch && r2Cursor ? { cursor: r2Cursor } : {}),
    });
    isFirstFetch = false;
    for (const obj of listed.objects) {
      const rest = filenameAfter(obj.key, prefix);
      const slash = rest.indexOf('/');
      if (slash < 0) continue;
      const tourId = rest.slice(0, slash);
      const filename = rest.slice(slash + 1);
      if (!groups.has(tourId)) orderedTourIds.push(tourId);
      const entry = groups.get(tourId) ?? {};
      if (filename === 'tour.json') {
        entry.tourObj = obj;
        completeCount += 1;
      } else if (filename === 'publish.json') {
        entry.publishObj = obj;
      }
      groups.set(tourId, entry);
    }
    if (!listed.truncated) break;
    r2Cursor = listed.cursor;
  }

  const completeTourIds = orderedTourIds.filter((id) => groups.get(id)?.tourObj);
  const hasMore = completeTourIds.length > limit;
  const pageTourIds = completeTourIds.slice(0, limit);

  const tours: TourSummary[] = [];
  for (const tourId of pageTourIds) {
    const group = groups.get(tourId) as { tourObj: R2Object; publishObj?: R2Object };
    const fields = await resolveTourFields(
      group.tourObj.customMetadata,
      async () => (await getJson<TourDoc>(bucket, group.tourObj.key))?.value ?? null,
    );
    const publish = toPublishSummary(group.publishObj?.customMetadata);
    tours.push({
      tourId,
      ...fields,
      updatedAt: group.tourObj.uploaded.toISOString(),
      etag: group.tourObj.etag,
      publish,
    });
  }
  return { tours, cursor: hasMore ? (pageTourIds[pageTourIds.length - 1] ?? null) : null };
};
