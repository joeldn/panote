import {
  configKey,
  manifestKey,
  panoPrefix,
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

export const tourCustomMetadata = (tour: TourDoc): Record<string, string> => ({
  title: tour.title,
  sceneCount: String(tour.scenes.length),
  coverPanoId: tour.scenes[0]?.panoId ?? '',
});

export const configCustomMetadata = (config: SceneConfig): Record<string, string> => ({
  title: config.title,
});

export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 100;

export const parseListLimit = (raw: string | undefined): number => {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIST_LIMIT;
  return Math.min(Math.trunc(n), MAX_LIST_LIMIT);
};

// Keyset pagination over an already-fully-listed, sorted id array. A
// stale/unknown cursor (indexOf -1) restarts from the top rather than 400ing.
export const paginateIds = (
  sorted: readonly string[],
  cursor: string | undefined,
  limit: number,
): { page: string[]; cursor: string | null } => {
  const startIndex = cursor !== undefined ? Math.max(sorted.indexOf(cursor) + 1, 0) : 0;
  const page = sorted.slice(startIndex, startIndex + limit);
  const hasMore = startIndex + page.length < sorted.length;
  return { page, cursor: hasMore ? (page[page.length - 1] ?? null) : null };
};

const filenameAfter = (key: string, prefix: string): string => key.slice(prefix.length);

// Reads the one prefix list() the plan budgets for readiness, plus the one
// manifest get() - no other read per pano when customMetadata is present.
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

  const manifestObj = await bucket.get(manifestKey(panoId));
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

// Groups tour.json + publish.json by tourId from one list() call (per the
// plan); publish.json is unwritten until B2, so publish is null until then.
export const listTourSummaries = async (
  bucket: R2Bucket,
  sub: string,
  cursor: string | undefined,
  limit: number,
): Promise<{ tours: TourSummary[]; cursor: string | null }> => {
  const prefix = userToursPrefix(sub);
  const listed = await bucket.list({
    prefix,
    include: ['customMetadata'],
    limit,
    ...(cursor ? { cursor } : {}),
  });
  const byTour = new Map<string, { tourObj?: R2Object; publishObj?: R2Object }>();
  for (const obj of listed.objects) {
    const rest = filenameAfter(obj.key, prefix);
    const slash = rest.indexOf('/');
    if (slash < 0) continue;
    const tourId = rest.slice(0, slash);
    const filename = rest.slice(slash + 1);
    const entry = byTour.get(tourId) ?? {};
    if (filename === 'tour.json') entry.tourObj = obj;
    else if (filename === 'publish.json') entry.publishObj = obj;
    byTour.set(tourId, entry);
  }

  const tours: TourSummary[] = [];
  for (const [tourId, { tourObj, publishObj }] of byTour) {
    // An orphaned publish.json with no tour.json shouldn't exist; skip it
    // defensively rather than surface a half-formed summary.
    if (!tourObj) continue;
    const fields = await resolveTourFields(
      tourObj.customMetadata,
      async () => (await getJson<TourDoc>(bucket, tourObj.key))?.value ?? null,
    );
    const publish = toPublishSummary(publishObj?.customMetadata);
    tours.push({
      tourId,
      ...fields,
      updatedAt: tourObj.uploaded.toISOString(),
      etag: tourObj.etag,
      publish,
    });
  }
  return { tours, cursor: listed.truncated ? listed.cursor : null };
};
