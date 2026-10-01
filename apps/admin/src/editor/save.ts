import {
  SceneConfigSchema,
  TourDocSchema,
  type PublishFailureReason,
  type PublishOk,
  type SceneConfig,
  type TourDoc,
} from '@internal/contracts';
import {
  ApiError,
  ConflictError,
  isAuthError,
  publishErrorOf,
  type AdminApi,
} from '@internal/web-kit';

import { isSceneDirty, isTourDirty, panoKey, type DocKey, type EditorDocs } from './model.js';

export type SaveApi = Pick<AdminApi, 'putTour' | 'putPanoConfig' | 'publishTour'>;

export interface SavePlan {
  tour: { doc: TourDoc; etag: string } | null;
  configs: Array<{ panoId: string; config: SceneConfig; etag: string | null }>;
}

/** Snapshot of every dirty document; Save sends exactly these, one PUT each. */
export function planSave(docs: EditorDocs): SavePlan {
  const configs: SavePlan['configs'] = [];
  for (const [panoId, s] of Object.entries(docs.scenes)) {
    if (isSceneDirty(s)) configs.push({ panoId, config: s.current, etag: s.etag });
  }
  return {
    tour: isTourDirty(docs) ? { doc: docs.tour.current, etag: docs.tour.etag } : null,
    configs,
  };
}

export const isEmptyPlan = (p: SavePlan): boolean => !p.tour && p.configs.length === 0;

export type DocFailure =
  | { kind: 'conflict' }
  | { kind: 'invalid'; message: string }
  | { kind: 'error'; message: string; status?: number }
  | { kind: 'auth' };

export interface SaveOutcome {
  tour?: { etag: string; sent: TourDoc };
  configs: Record<string, { etag: string; sent: SceneConfig }>;
  failures: Partial<Record<DocKey, DocFailure>>;
}

function failureOf(e: unknown): DocFailure {
  if (e instanceof ConflictError) return { kind: 'conflict' };
  if (isAuthError(e)) return { kind: 'auth' };
  if (e instanceof ApiError) {
    if (e.status === 404) return { kind: 'error', status: 404, message: 'It no longer exists.' };
    if (e.status === 409)
      return { kind: 'error', status: 409, message: 'This pano is being deleted.' };
    return { kind: 'error', status: e.status, message: e.message };
  }
  return { kind: 'error', message: e instanceof Error ? e.message : 'Network error' };
}

const firstIssue = (issues: { path: (string | number)[]; message: string }[]): string => {
  const i = issues[0];
  return i ? `${i.path.join('.') || 'document'}: ${i.message}` : 'invalid document';
};

/**
 * PUT every planned document with its own If-Match (a missing config uses `*`),
 * configs first, then the tour. Never throws: each document reports its own result.
 */
export async function runSave(api: SaveApi, tourId: string, plan: SavePlan): Promise<SaveOutcome> {
  const out: SaveOutcome = { configs: {}, failures: {} };
  await Promise.all(
    plan.configs.map(async ({ panoId, config, etag }) => {
      const key = panoKey(panoId);
      const valid = SceneConfigSchema.safeParse(config);
      if (!valid.success) {
        out.failures[key] = { kind: 'invalid', message: firstIssue(valid.error.issues) };
        return;
      }
      try {
        const res = await api.putPanoConfig(panoId, config, etag ?? '*');
        out.configs[panoId] = { etag: res.etag, sent: config };
      } catch (e) {
        out.failures[key] = failureOf(e);
      }
    }),
  );
  if (plan.tour) {
    const valid = TourDocSchema.safeParse(plan.tour.doc);
    if (!valid.success) {
      out.failures.tour = { kind: 'invalid', message: firstIssue(valid.error.issues) };
    } else {
      try {
        const res = await api.putTour(tourId, plan.tour.doc, plan.tour.etag);
        out.tour = { etag: res.etag, sent: plan.tour.doc };
      } catch (e) {
        out.failures.tour = failureOf(e);
      }
    }
  }
  return out;
}

export type PublishOutcome =
  | { kind: 'ok'; publish: PublishOk }
  | { kind: 'slug-lost' }
  | { kind: 'unpublishable'; scenes: Array<{ panoId: string; reason: PublishFailureReason }> }
  | { kind: 'failed'; message: string };

/** Publish after a successful Save (plan 3.2, D7). Never throws: the save already succeeded. */
export async function runPublish(api: SaveApi, tourId: string): Promise<PublishOutcome> {
  try {
    return { kind: 'ok', publish: await api.publishTour(tourId) };
  } catch (e) {
    const err = publishErrorOf(e);
    if (err?.kind === 'slug-lost') return { kind: 'slug-lost' };
    if (err?.kind === 'unprocessable') return { kind: 'unpublishable', scenes: err.scenes };
    if (isAuthError(e))
      return { kind: 'failed', message: 'Sign in again to update the share link.' };
    return {
      kind: 'failed',
      message: e instanceof Error ? e.message : 'The share link could not be updated.',
    };
  }
}
