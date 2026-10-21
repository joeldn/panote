import type { z } from 'zod';

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
      return 'This account has been disabled. Write to hello@panote.io if you think that is a mistake.';
    }
    // upload-api's per-owner quotas.
    if (status === 403 && body.error === 'pano limit reached') {
      return 'This account has reached its pano limit.';
    }
    if (status === 403 && body.error === 'storage limit reached') {
      return 'This account has reached its storage limit.';
    }
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
