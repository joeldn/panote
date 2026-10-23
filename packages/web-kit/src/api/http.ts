import { MAX_TOURS_PER_OWNER } from '@internal/contracts';
import type { z } from 'zod';

import { CONTACT_EMAIL } from '../contact.js';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
export type TokenGetter = () => Promise<string>;

/** A non-2xx response the caller did not expect. `body` is the parsed JSON, if any. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
    message?: string,
  ) {
    super(message ?? errorMessage(status, body));
    this.name = 'ApiError';
  }
}

/** 412: the document changed since its ETag was read. The editor shows its conflict state. */
export class ConflictError extends ApiError {
  constructor(body: unknown) {
    super(412, body, 'document changed elsewhere');
    this.name = 'ConflictError';
  }
}

/**
 * 403 from account delete: the sign-in is too old (or the token doesn't say when it was).
 * Sign in again with `reauthenticate: true`, then retry.
 */
export class ReauthRequiredError extends ApiError {
  constructor(body: unknown) {
    super(403, body, 'a recent sign-in is required');
    this.name = 'ReauthRequiredError';
  }
}

/** A 2xx body that failed its contract schema. Never retried: it is a server/client drift bug. */
export class ApiSchemaError extends Error {
  constructor(
    readonly url: string,
    readonly issues: z.ZodIssue[],
  ) {
    super(
      `response from ${url} failed validation: ${issues
        .slice(0, 3)
        .map((i) => `${i.path.join('.') || '(root)'} ${i.message}`)
        .join('; ')}`,
    );
    this.name = 'ApiSchemaError';
  }
}

function errorMessage(status: number, body: unknown): string {
  if (body && typeof body === 'object' && 'error' in body && typeof body.error === 'string') {
    // admin-api and upload-api refuse every write once the account is marked for deletion.
    if (status === 410 && body.error === 'account deleted') return 'This account has been deleted.';
    // The operator disabled the account (scripts/takedown.ts): reads only from then on.
    if (status === 403 && body.error === 'account disabled') {
      return `This account has been disabled. Write to ${CONTACT_EMAIL} if you think that is a mistake.`;
    }
    // upload-api's per-owner quotas.
    if (status === 403 && body.error === 'pano limit reached') {
      return 'This account has reached its pano limit.';
    }
    if (status === 403 && body.error === 'storage limit reached') {
      return 'This account has reached its storage limit.';
    }
    if (status === 403 && body.error === 'daily upload limit reached') {
      return 'This account has reached its daily upload limit. Try again later today or tomorrow.';
    }
    // upload-api's per-tour cap on floor-plan images; the editor's save clears unused ones.
    if (status === 403 && body.error === 'plan storage limit reached') {
      return 'This tour has too many floor-plan images waiting. Save the tour, then try again in an hour.';
    }
    // upload-api's global daily ceiling, across every account: it lifts at 00:00 UTC.
    if (status === 503 && body.error === 'uploads paused') {
      return 'Uploads are paused for today. Try again tomorrow.';
    }
    // admin-api's per-owner tour cap (MAX_TOURS_PER_OWNER).
    if (status === 403 && body.error === 'tour limit reached') {
      return `This account has reached its limit of ${MAX_TOURS_PER_OWNER} tours.`;
    }
    // admin-api refuses a config for a pano that was never uploaded.
    if (status === 404 && body.error === 'pano not found') return 'This pano no longer exists.';
    if (status === 429) return 'Too many requests. Wait a minute and try again.';
    return `${status}: ${body.error}`;
  }
  return `request failed with ${status}`;
}

export async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export function parseWith<S extends z.ZodTypeAny>(
  schema: S,
  url: string,
  body: unknown,
): z.output<S> {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new ApiSchemaError(url, parsed.error.issues);
  return parsed.data as z.output<S>;
}

/** Strip the quotes (and a weak `W/` prefix) from an HTTP ETag header. */
export const unquoteEtag = (etag: string): string => etag.replace(/^W\//, '').replace(/^"|"$/g, '');
