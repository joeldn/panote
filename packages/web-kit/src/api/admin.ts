import {
  DEFAULT_INSIGHTS_DAYS,
  InsightsOkSchema,
  InsightsUnavailableSchema,
  NotPublishedSchema,
  PANO_PATTERN,
  PanoConfigNotFoundSchema,
  PanosListOkSchema,
  PanoStatusOnlyOkSchema,
  PanoWithStatusOkSchema,
  PublishConflictSchema,
  PublishOkSchema,
  PublishUnprocessableSchema,
  SlugInvalidSchema,
  SlugLostSchema,
  SlugPutOkSchema,
  SlugTakenSchema,
  TourNotFoundSchema,
  TourOkSchema,
  ToursListOkSchema,
  TourWithConfigsOkSchema,
  type InsightsOk,
  type PanosListOk,
  type PanoStatus,
  type PanoWithStatusOk,
  type PublishFailureReason,
  type PublishOk,
  type PublishRequest,
  type SceneConfigSchema,
  type SlugPutOk,
  type TourDocSchema,
  type ToursListOk,
  type TourOk,
  type TourWithConfigsOk,
  type Visibility,
  VisibilityOkSchema,
  type VisibilityOk,
} from '@internal/contracts';
import { z } from 'zod';

import { AuthRequiredError } from '../auth.js';

import {
  ApiError,
  ConflictError,
  parseWith,
  readJson,
  unquoteEtag,
  type FetchLike,
  type TokenGetter,
} from './http.js';

// Write-route bodies have no shared contract schema yet; these mirror
// services/admin-api/src/index.ts exactly.
const EtagOkSchema = z.object({ etag: z.string().min(1) });
const TourCreatedSchema = z.object({ tourId: z.string().regex(PANO_PATTERN) });

export type SceneConfigInput = Omit<z.input<typeof SceneConfigSchema>, 'panoId'> & {
  panoId?: string;
};
export type TourDocInput = Omit<z.input<typeof TourDocSchema>, 'tourId'> & { tourId?: string };

export type GetResult<T, NotFound = { status: 'not-found' }> =
  { status: 'ok'; data: T } | { status: 'not-modified'; etag: string } | NotFound;

export type PanoNotFound = { status: 'not-found'; deleting: boolean; hasOriginal: boolean };

/** `unavailable` is admin-api's 502 when the Analytics Engine query fails. */
export type InsightsResult =
  { status: 'ok'; data: InsightsOk } | { status: 'unavailable' } | { status: 'not-found' };

export interface ListQuery {
  cursor?: string;
  limit?: number;
}

export interface ConditionalQuery {
  /** Unquoted etag from a previous load; a match gives `not-modified`. */
  ifNoneMatch?: string;
}

export interface AdminApiOptions {
  getToken: TokenGetter;
  /** API origin; `''` (default) is same-origin. */
  baseUrl?: string;
  fetch?: FetchLike;
}

export interface AdminApi {
  listTours(q?: ListQuery): Promise<ToursListOk>;
  listPanos(q?: ListQuery): Promise<PanosListOk>;
  getTour(tourId: string, q?: ConditionalQuery): Promise<GetResult<TourOk>>;
  getTourWithConfigs(tourId: string, q?: ConditionalQuery): Promise<GetResult<TourWithConfigsOk>>;
  getPano(panoId: string, q?: ConditionalQuery): Promise<GetResult<PanoWithStatusOk, PanoNotFound>>;
  getPanoStatus(panoId: string): Promise<PanoStatus>;
  createTour(doc: TourDocInput): Promise<{ tourId: string }>;
  /** `ifMatch` is the etag from the last load; a stale one throws `ConflictError`. */
  putTour(tourId: string, doc: TourDocInput, ifMatch: string): Promise<{ etag: string }>;
  /** `ifMatch: '*'` creates a config that does not exist yet. */
  putPanoConfig(
    panoId: string,
    config: SceneConfigInput,
    ifMatch: string,
  ): Promise<{ etag: string }>;
  /** Create-only (`If-None-Match: *`): throws `ConflictError` if the config already exists. */
  createPanoConfig(panoId: string, config: SceneConfigInput): Promise<{ etag: string }>;
  deleteTour(tourId: string): Promise<void>;
  deletePano(panoId: string): Promise<void>;
  /** Idempotent; failures are an `ApiError`, classify them with `publishErrorOf`. */
  publishTour(tourId: string, req?: PublishRequest): Promise<PublishOk>;
  renameSlug(tourId: string, slug: string): Promise<SlugPutOk>;
  setVisibility(tourId: string, visibility: Visibility): Promise<VisibilityOk>;
  unpublishTour(tourId: string): Promise<void>;
  getInsights(tourId: string, days?: number): Promise<InsightsResult>;
}

/** A publish, slug or visibility failure the share UI reacts to (plan 3.2). */
export type PublishError =
  | { kind: 'slug-taken' | 'slug-lost' | 'conflict' | 'not-published' | 'not-found' }
  | { kind: 'slug-invalid'; reason: 'invalid' | 'reserved' }
  | { kind: 'unprocessable'; scenes: Array<{ panoId: string; reason: PublishFailureReason }> };

/** Classify an error from the publish routes; null for anything else (network, 5xx, auth). */
export function publishErrorOf(e: unknown): PublishError | null {
  if (!(e instanceof ApiError) || e instanceof ConflictError) return null;
  const is = (schema: z.ZodTypeAny) => schema.safeParse(e.body).success;
  if (e.status === 404) return { kind: 'not-found' };
  if (e.status === 409) {
    if (is(SlugTakenSchema)) return { kind: 'slug-taken' };
    if (is(SlugLostSchema)) return { kind: 'slug-lost' };
    if (is(NotPublishedSchema)) return { kind: 'not-published' };
    if (is(PublishConflictSchema)) return { kind: 'conflict' };
  }
  if (e.status === 400) {
    const invalid = SlugInvalidSchema.safeParse(e.body);
    if (invalid.success) {
      return {
        kind: 'slug-invalid',
        reason: invalid.data.error === 'reserved slug' ? 'reserved' : 'invalid',
      };
    }
  }
  if (e.status === 422) {
    const body = PublishUnprocessableSchema.safeParse(e.body);
    if (body.success) return { kind: 'unprocessable', scenes: body.data.scenes };
  }
  return null;
}

const assertId = (id: string, name: string): string => {
  if (!PANO_PATTERN.test(id)) throw new TypeError(`${name} must match ${PANO_PATTERN}`);
  return id;
};

const tourPath = (tourId: string): string => `/api/admin/tours/${assertId(tourId, 'tourId')}`;

const listPath = (path: string, q: ListQuery = {}): string => {
  const params = new URLSearchParams();
  if (q.cursor !== undefined) params.set('cursor', q.cursor);
  if (q.limit !== undefined) params.set('limit', String(q.limit));
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
};

export function createAdminApi(opts: AdminApiOptions): AdminApi {
  const base = (opts.baseUrl ?? '').replace(/\/+$/, '');
  const doFetch: FetchLike = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));

  async function send(
    method: string,
    path: string,
    init: { body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<{ res: Response; url: string; body: unknown }> {
    const url = `${base}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${await opts.getToken()}`,
      Accept: 'application/json',
      ...init.headers,
    };
    const request: RequestInit = { method, headers };
    if (init.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      request.body = JSON.stringify(init.body);
    }
    const res = await doFetch(url, request);
    // One error type for "sign in again", whether the token or the API said so.
    if (res.status === 401) throw new AuthRequiredError(`401 from ${path}`);
    return {
      res,
      url,
      body: res.status === 204 || res.status === 304 ? null : await readJson(res),
    };
  }

  async function getJson<S extends z.ZodTypeAny>(path: string, schema: S): Promise<z.output<S>> {
    const { res, url, body } = await send('GET', path);
    if (!res.ok) throw new ApiError(res.status, body);
    return parseWith(schema, url, body);
  }

  async function conditionalGet<S extends z.ZodTypeAny, NF>(
    path: string,
    schema: S,
    q: ConditionalQuery,
    notFound: (url: string, body: unknown) => NF,
  ): Promise<GetResult<z.output<S>, NF>> {
    const headers: Record<string, string> = {};
    if (q.ifNoneMatch) headers['If-None-Match'] = `"${unquoteEtag(q.ifNoneMatch)}"`;
    const { res, url, body } = await send('GET', path, { headers });
    if (res.status === 304) {
      const etag = res.headers.get('ETag');
      return { status: 'not-modified', etag: etag ? unquoteEtag(etag) : (q.ifNoneMatch ?? '') };
    }
    if (res.status === 404) return notFound(url, body);
    if (!res.ok) throw new ApiError(res.status, body);
    return { status: 'ok', data: parseWith(schema, url, body) };
  }

  async function write<S extends z.ZodTypeAny>(
    method: 'PUT' | 'POST' | 'PATCH',
    path: string,
    body: unknown,
    schema: S,
    ifMatch?: string,
  ): Promise<z.output<S>> {
    const headers: Record<string, string> = {};
    if (ifMatch !== undefined) {
      if (!ifMatch) throw new TypeError('If-Match is required for updates');
      headers['If-Match'] = ifMatch === '*' ? '*' : `"${unquoteEtag(ifMatch)}"`;
    }
    const res = await send(method, path, { body, headers });
    if (res.res.status === 412) throw new ConflictError(res.body);
    if (!res.res.ok) throw new ApiError(res.res.status, res.body);
    return parseWith(schema, res.url, res.body);
  }

  async function del(path: string): Promise<void> {
    const { res, body } = await send('DELETE', path);
    if (!res.ok) throw new ApiError(res.status, body);
  }

  const tourNotFound = (url: string, body: unknown) => {
    parseWith(TourNotFoundSchema, url, body);
    return { status: 'not-found' as const };
  };

  return {
    listTours: async (q) => getJson(listPath('/api/admin/tours', q), ToursListOkSchema),
    listPanos: async (q) => getJson(listPath('/api/admin/panos', q), PanosListOkSchema),
    getTour: async (tourId, q = {}) =>
      conditionalGet(
        `/api/admin/tours/${assertId(tourId, 'tourId')}`,
        TourOkSchema,
        q,
        tourNotFound,
      ),
    getTourWithConfigs: async (tourId, q = {}) =>
      conditionalGet(
        `/api/admin/tours/${assertId(tourId, 'tourId')}?include=configs`,
        TourWithConfigsOkSchema,
        q,
        tourNotFound,
      ),
    getPano: async (panoId, q = {}) =>
      conditionalGet(
        `/api/admin/panos/${assertId(panoId, 'panoId')}`,
        PanoWithStatusOkSchema,
        q,
        (url, body) => {
          const nf = parseWith(PanoConfigNotFoundSchema, url, body);
          return { status: 'not-found', deleting: nf.deleting, hasOriginal: nf.hasOriginal };
        },
      ),
    getPanoStatus: async (panoId) =>
      (
        await getJson(
          `/api/admin/panos/${assertId(panoId, 'panoId')}?status=1`,
          PanoStatusOnlyOkSchema,
        )
      ).status,
    createTour: async (doc) => write('POST', '/api/admin/tours', doc, TourCreatedSchema),
    putTour: async (tourId, doc, ifMatch) =>
      write('PUT', `/api/admin/tours/${assertId(tourId, 'tourId')}`, doc, EtagOkSchema, ifMatch),
    putPanoConfig: async (panoId, config, ifMatch) =>
      write(
        'PUT',
        `/api/admin/panos/${assertId(panoId, 'panoId')}/config`,
        config,
        EtagOkSchema,
        ifMatch,
      ),
    createPanoConfig: async (panoId, config) => {
      const path = `/api/admin/panos/${assertId(panoId, 'panoId')}/config`;
      const res = await send('PUT', path, { body: config, headers: { 'If-None-Match': '*' } });
      if (res.res.status === 412) throw new ConflictError(res.body);
      if (!res.res.ok) throw new ApiError(res.res.status, res.body);
      return parseWith(EtagOkSchema, res.url, res.body);
    },
    deleteTour: async (tourId) => del(`/api/admin/tours/${assertId(tourId, 'tourId')}`),
    deletePano: async (panoId) => del(`/api/admin/panos/${assertId(panoId, 'panoId')}`),
    publishTour: async (tourId, req = {}) =>
      write('POST', `${tourPath(tourId)}/publish`, req, PublishOkSchema),
    renameSlug: async (tourId, slug) =>
      write('PUT', `${tourPath(tourId)}/slug`, { slug }, SlugPutOkSchema),
    setVisibility: async (tourId, visibility) =>
      write('PATCH', `${tourPath(tourId)}/visibility`, { visibility }, VisibilityOkSchema),
    unpublishTour: async (tourId) => del(`${tourPath(tourId)}/publish`),
    getInsights: async (tourId, days = DEFAULT_INSIGHTS_DAYS) => {
      const { res, url, body } = await send('GET', `${tourPath(tourId)}/insights?days=${days}`);
      if (res.status === 404) {
        parseWith(TourNotFoundSchema, url, body);
        return { status: 'not-found' };
      }
      if (res.status === 502 && InsightsUnavailableSchema.safeParse(body).success) {
        return { status: 'unavailable' };
      }
      if (!res.ok) throw new ApiError(res.status, body);
      return { status: 'ok', data: parseWith(InsightsOkSchema, url, body) };
    },
  };
}
