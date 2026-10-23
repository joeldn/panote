import {
  AccountDeleteOkSchema,
  DEFAULT_INSIGHTS_DAYS,
  InsightsOkSchema,
  InsightsUnavailableSchema,
  InviteAcceptOkSchema,
  InviteCreateOkSchema,
  InviteRefusedSchema,
  TransferAcceptOkSchema,
  TransferOfferOkSchema,
  TransferRefusedSchema,
  MembersOkSchema,
  NotPublishedSchema,
  SharingStoppedSchema,
  PANO_PATTERN,
  PanoConfigNotFoundSchema,
  PANO_DELETE_CONFLICTS,
  PanoDeleteConflictSchema,
  PanosListOkSchema,
  PanoStatusOnlyOkSchema,
  PanoWithStatusOkSchema,
  PublishConflictSchema,
  PublishOkSchema,
  PublishUnprocessableSchema,
  ReauthRequiredSchema,
  SlugInvalidSchema,
  SlugLostSchema,
  TooManyRenamesSchema,
  SlugPutOkSchema,
  SlugTakenSchema,
  SharedToursOkSchema,
  AccountViewSchema,
  TourNotFoundSchema,
  TourOkSchema,
  ToursListOkSchema,
  TourWithConfigsOkSchema,
  type AccountDeleteOk,
  type InsightsOk,
  type InviteAcceptOk,
  type InviteCreateOk,
  type InviteRefused,
  type TransferAcceptOk,
  type TransferOfferOk,
  type TransferRefused,
  type MembersOk,
  type PanoDeleteConflict,
  type PanosListOk,
  type PanoStatus,
  type PanoWithStatusOk,
  type PublishFailureReason,
  type PublishOk,
  type PublishRequest,
  type SceneConfigSchema,
  type SharedToursOk,
  type AccountView,
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
  ReauthRequiredError,
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

export interface PanoListQuery extends ListQuery {
  /** Adds `referenced` to each pano; costs the server one read per tour. */
  includeReferences?: boolean;
}

export interface ConditionalQuery {
  /** Unquoted etag from a previous load; a match gives `not-modified`. */
  ifNoneMatch?: string;
}

/**
 * The tour a pano call is made for. An editor reaches the tour owner's panos only this way;
 * the owner may pass it too.
 */
export interface PanoScope {
  tourId?: string;
}

/** An invite accept the server refused, with the address the invite is for when it says. */
export type InviteAcceptResult =
  { status: 'ok'; data: InviteAcceptOk } | { status: 'refused'; refusal: InviteRefused };

/** Taking over a tour: done, or why not (an offer gone, a limit of the new owner's). */
export type TransferAcceptResult =
  | { status: 'ok'; data: TransferAcceptOk }
  | { status: 'refused'; refusal: TransferRefused }
  /** Accepted, but a large tour is still moving: accept again to finish it. */
  | { status: 'finishing' };

export interface AdminApiOptions {
  getToken: TokenGetter;
  /** API origin; `''` (default) is same-origin. */
  baseUrl?: string;
  fetch?: FetchLike;
}

export interface AdminApi {
  listTours(q?: ListQuery): Promise<ToursListOk>;
  listPanos(q?: PanoListQuery): Promise<PanosListOk>;
  getTour(tourId: string, q?: ConditionalQuery): Promise<GetResult<TourOk>>;
  getTourWithConfigs(tourId: string, q?: ConditionalQuery): Promise<GetResult<TourWithConfigsOk>>;
  getPano(
    panoId: string,
    q?: ConditionalQuery & PanoScope,
  ): Promise<GetResult<PanoWithStatusOk, PanoNotFound>>;
  getPanoStatus(panoId: string, scope?: PanoScope): Promise<PanoStatus>;
  createTour(doc: TourDocInput): Promise<{ tourId: string }>;
  /** `ifMatch` is the etag from the last load; a stale one throws `ConflictError`. */
  putTour(tourId: string, doc: TourDocInput, ifMatch: string): Promise<{ etag: string }>;
  /** `ifMatch: '*'` creates a config that does not exist yet. */
  putPanoConfig(
    panoId: string,
    config: SceneConfigInput,
    ifMatch: string,
    scope?: PanoScope,
  ): Promise<{ etag: string }>;
  /** Create-only (`If-None-Match: *`): throws `ConflictError` if the config already exists. */
  createPanoConfig(
    panoId: string,
    config: SceneConfigInput,
    scope?: PanoScope,
  ): Promise<{ etag: string }>;
  deleteTour(tourId: string): Promise<void>;
  /** Refusals are an `ApiError`; classify them with `panoDeleteErrorOf`. */
  deletePano(panoId: string): Promise<void>;
  /** Idempotent; failures are an `ApiError`, classify them with `publishErrorOf`. */
  publishTour(tourId: string, req?: PublishRequest): Promise<PublishOk>;
  renameSlug(tourId: string, slug: string): Promise<SlugPutOk>;
  setVisibility(tourId: string, visibility: Visibility): Promise<VisibilityOk>;
  unpublishTour(tourId: string): Promise<void>;
  getInsights(tourId: string, days?: number): Promise<InsightsResult>;
  /**
   * Deletes the signed-in account and everything in it. `confirm` is the phrase
   * the owner typed; the server checks it against ACCOUNT_DELETE_CONFIRMATION.
   * Throws `ReauthRequiredError` when the server wants a more recent sign-in.
   */
  deleteAccount(confirm: string): Promise<AccountDeleteOk>;
  /** The tour's owner, editors and (for the owner) pending invites. */
  getMembers(tourId: string): Promise<MembersOk>;
  /** Owner only. The returned token is the only copy: the link is built from it. */
  createInvite(tourId: string, email: string): Promise<InviteCreateOk>;
  revokeInvite(tourId: string, inviteId: string): Promise<void>;
  /** The owner removes an editor; an editor removes themselves (leaves the tour). */
  removeMember(tourId: string, memberId: string): Promise<void>;
  acceptInvite(token: string): Promise<InviteAcceptResult>;
  /** Tours other people shared with the signed-in user. */
  listSharedTours(): Promise<SharedToursOk>;
  /** The signed-in user's email and sign-in methods, for the account page. */
  getAccount(): Promise<AccountView>;
  /**
   * Offers the tour to one of its editors, owner only. Needs a recent sign-in: throws
   * ReauthRequiredError when the last one is too old, as deleteAccount does.
   */
  offerTransfer(tourId: string, memberId: string): Promise<TransferOfferOk>;
  /** Withdraws the offer (owner), or turns it down (the editor it names). */
  cancelTransfer(tourId: string): Promise<void>;
  /** The editor the offer names takes the tour over. */
  acceptTransfer(tourId: string): Promise<TransferAcceptResult>;
}

/** A publish, slug or visibility failure the share UI reacts to (plan 3.2). */
export type PublishError =
  | {
      kind:
        | 'slug-taken'
        | 'slug-lost'
        | 'conflict'
        | 'not-published'
        | 'not-found'
        | 'sharing-stopped'
        | 'too-many-renames'
        | 'rate-limited';
    }
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
    if (is(SharingStoppedSchema)) return { kind: 'sharing-stopped' };
    if (is(PublishConflictSchema)) return { kind: 'conflict' };
    if (is(TooManyRenamesSchema)) return { kind: 'too-many-renames' };
  }
  // admin-api's per-owner write rate limit.
  if (e.status === 429) return { kind: 'rate-limited' };
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

/** Why a pano delete was refused: a 409 reason, or `not-found` (already gone). */
export type PanoDeleteError = PanoDeleteConflict | 'not-found';

/** Classify an error from `deletePano`; null for anything else (network, 5xx, auth). */
export function panoDeleteErrorOf(e: unknown): PanoDeleteError | null {
  if (!(e instanceof ApiError) || e instanceof ConflictError) return null;
  if (e.status === 404) return 'not-found';
  if (e.status !== 409) return null;
  const body = PanoDeleteConflictSchema.safeParse(e.body);
  if (!body.success) return null;
  const entry = Object.entries(PANO_DELETE_CONFLICTS).find(([, msg]) => msg === body.data.error);
  return entry ? (entry[0] as PanoDeleteConflict) : null;
}

const assertId = (id: string, name: string): string => {
  if (!PANO_PATTERN.test(id)) throw new TypeError(`${name} must match ${PANO_PATTERN}`);
  return id;
};

const tourPath = (tourId: string): string => `/api/admin/tours/${assertId(tourId, 'tourId')}`;

const panoPath = (panoId: string, scope: PanoScope = {}, query = ''): string => {
  const params = new URLSearchParams(query);
  if (scope.tourId !== undefined) params.set('tourId', assertId(scope.tourId, 'tourId'));
  const qs = params.toString();
  return `/api/admin/panos/${assertId(panoId, 'panoId')}${qs ? `?${qs}` : ''}`;
};

const configPath = (panoId: string, scope: PanoScope = {}): string => {
  const [path, qs] = panoPath(panoId, scope).split('?');
  return `${path}/config${qs ? `?${qs}` : ''}`;
};

const listPath = (path: string, q: PanoListQuery = {}): string => {
  const params = new URLSearchParams();
  if (q.cursor !== undefined) params.set('cursor', q.cursor);
  if (q.limit !== undefined) params.set('limit', String(q.limit));
  if (q.includeReferences) params.set('include', 'references');
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
      conditionalGet(panoPath(panoId, q), PanoWithStatusOkSchema, q, (url, body) => {
        const nf = parseWith(PanoConfigNotFoundSchema, url, body);
        return { status: 'not-found', deleting: nf.deleting, hasOriginal: nf.hasOriginal };
      }),
    getPanoStatus: async (panoId, scope) =>
      (await getJson(panoPath(panoId, scope, 'status=1'), PanoStatusOnlyOkSchema)).status,
    createTour: async (doc) => write('POST', '/api/admin/tours', doc, TourCreatedSchema),
    putTour: async (tourId, doc, ifMatch) =>
      write('PUT', `/api/admin/tours/${assertId(tourId, 'tourId')}`, doc, EtagOkSchema, ifMatch),
    putPanoConfig: async (panoId, config, ifMatch, scope) =>
      write('PUT', configPath(panoId, scope), config, EtagOkSchema, ifMatch),
    createPanoConfig: async (panoId, config, scope) => {
      const path = configPath(panoId, scope);
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
    deleteAccount: async (confirm) => {
      const { res, url, body } = await send('DELETE', '/api/admin/account', { body: { confirm } });
      if (res.status === 403 && ReauthRequiredSchema.safeParse(body).success) {
        throw new ReauthRequiredError(body);
      }
      if (!res.ok) throw new ApiError(res.status, body);
      return parseWith(AccountDeleteOkSchema, url, body);
    },
    getMembers: async (tourId) => getJson(`${tourPath(tourId)}/members`, MembersOkSchema),
    createInvite: async (tourId, email) =>
      write('POST', `${tourPath(tourId)}/invites`, { email }, InviteCreateOkSchema),
    revokeInvite: async (tourId, inviteId) =>
      del(`${tourPath(tourId)}/invites/${assertId(inviteId, 'inviteId')}`),
    removeMember: async (tourId, memberId) =>
      del(`${tourPath(tourId)}/members/${assertId(memberId, 'memberId')}`),
    acceptInvite: async (token) => {
      const { res, url, body } = await send('POST', '/api/admin/invites/accept', {
        body: { token },
      });
      if (!res.ok) {
        const refused = InviteRefusedSchema.safeParse(body);
        if (refused.success) return { status: 'refused', refusal: refused.data };
        throw new ApiError(res.status, body);
      }
      return { status: 'ok', data: parseWith(InviteAcceptOkSchema, url, body) };
    },
    listSharedTours: async () => getJson('/api/admin/shared-tours', SharedToursOkSchema),
    getAccount: async () => getJson('/api/admin/account', AccountViewSchema),
    offerTransfer: async (tourId, memberId) => {
      const { res, url, body } = await send('POST', `${tourPath(tourId)}/transfer`, {
        body: { memberId },
      });
      if (res.status === 403 && ReauthRequiredSchema.safeParse(body).success) {
        throw new ReauthRequiredError(body);
      }
      if (!res.ok) throw new ApiError(res.status, body);
      return parseWith(TransferOfferOkSchema, url, body);
    },
    cancelTransfer: async (tourId) => del(`${tourPath(tourId)}/transfer`),
    acceptTransfer: async (tourId) => {
      const { res, url, body } = await send('POST', `${tourPath(tourId)}/transfer/accept`);
      if (!res.ok) {
        const refused = TransferRefusedSchema.safeParse(body);
        if (refused.success) return { status: 'refused', refusal: refused.data };
        throw new ApiError(res.status, body);
      }
      if (res.status === 202) return { status: 'finishing' };
      return { status: 'ok', data: parseWith(TransferAcceptOkSchema, url, body) };
    },
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
