import { PreconditionRequiredError, WorkerError } from '@internal/worker-kit';
import { JSON_HTTP_METADATA } from '@internal/worker-kit/r2-binding';

// RFC 9110 §8.8.3: If-Match/If-None-Match are a comma list of (optionally
// weak, `W/`-prefixed) quoted etags. `*` is handled separately below.
const ETAG_RE = /(?:W\/)?"([^"]*)"/g;

// A bare (unquoted) tag - this app's own PUT responses hand back an
// unquoted etag - must not contain characters R2 rejects downstream.
const BARE_TAG_RE = /^[^",\s]+$/;

type ParsedETags = { wildcard: true } | { wildcard: false; tags: string[] };

// A header is a wildcard only when it IS `*`, not merely contains one -
// `x*y` is a (mismatching) literal tag, not an unconditional match.
const parseETags = (header: string): ParsedETags => {
  const trimmed = header.trim();
  if (trimmed === '*') return { wildcard: true };
  const tags: string[] = [];
  for (const m of header.matchAll(ETAG_RE)) tags.push(m[1] ?? '');
  if (tags.length > 0) return { wildcard: false, tags };
  // Not a well-formed quoted list - fall back to one bare tag, but only if
  // it's safe to hand to R2 (no quotes/commas/whitespace); otherwise treat
  // it as an empty (unmatchable) list rather than erroring downstream.
  return { wildcard: false, tags: BARE_TAG_RE.test(trimmed) ? [trimmed] : [] };
};

/**
 * R2 precondition for a mutating PUT. A missing `If-Match` is rejected with 428
 * rather than silently degrading to create-only. `*` means unconditional.
 */
export const updateConditional = (ifMatch: string | undefined): R2Conditional | undefined => {
  if (!ifMatch) throw new PreconditionRequiredError();
  const parsed = parseETags(ifMatch);
  if (parsed.wildcard) return undefined;
  if (parsed.tags.length > 1) throw new WorkerError('If-Match must be a single etag or *', 400);
  if (parsed.tags.length === 0) {
    // Unparsable/unsafe (see parseETags): 412 directly, same body as a
    // normal conflict, rather than depend on how R2 treats an empty etag.
    throw new WorkerError('conflict', 412);
  }
  return { etagMatches: parsed.tags[0] ?? '' };
};

/** True for the body-bearing branch of R2Bucket#get's conditional return type. */
const hasBody = (obj: R2Object | R2ObjectBody): obj is R2ObjectBody => 'body' in obj;

export type ConditionalGetResult =
  { notModified: true; etag: string } | { notModified: false; obj: R2ObjectBody };

/**
 * Conditional GET honouring If-None-Match. A single tag uses R2's own
 * `onlyIf`; a wildcard or a list is compared against the etag in code.
 */
export const conditionalGet = async (
  bucket: R2Bucket,
  key: string,
  ifNoneMatch: string | undefined,
): Promise<ConditionalGetResult | null> => {
  if (!ifNoneMatch) {
    const obj = await bucket.get(key);
    return obj ? { notModified: false, obj } : null;
  }
  const parsed = parseETags(ifNoneMatch);
  if (!parsed.wildcard && parsed.tags.length === 1) {
    const onlyIf = { etagDoesNotMatch: parsed.tags[0] ?? '' };
    const got = await bucket.get(key, { onlyIf });
    if (!got) return null;
    return hasBody(got) ? { notModified: false, obj: got } : { notModified: true, etag: got.etag };
  }
  // Wildcard, an empty (unparsable) list, or a multi-tag list: none of
  // these map onto R2's single-value onlyIf, so compare against the
  // object's etag ourselves. An empty list never matches (200).
  const obj = await bucket.get(key);
  if (!obj) return null;
  const matched = parsed.wildcard || parsed.tags.includes(obj.etag);
  return matched ? { notModified: true, etag: obj.etag } : { notModified: false, obj };
};

export type GuardedPutResult = { ok: true; etag: string } | { ok: false; status: 404 | 412 };

// The narrow slice of R2Bucket guardedPut needs - a real R2Bucket satisfies
// this trivially; tests can fake just `head()` to inject a stale read.
export interface HeadAndPut {
  head(key: string): Promise<R2Object | null>;
  put(
    key: string,
    value: string,
    options: { onlyIf: R2Conditional; httpMetadata: R2HTTPMetadata },
  ): Promise<R2Object | null>;
}

/**
 * A PUT that refuses to create: 404 if `key` doesn't exist. A wildcard
 * `conditional` (from `updateConditional`) is pinned to the etag this
 * same head() saw, so a write racing in between 412s instead of either
 * overwriting it blindly or resurrecting a since-deleted key.
 */
export const guardedPut = async (
  bucket: HeadAndPut,
  key: string,
  value: unknown,
  conditional: R2Conditional | undefined,
): Promise<GuardedPutResult> => {
  const existing = await bucket.head(key);
  if (!existing) return { ok: false, status: 404 };
  const onlyIf = conditional ?? { etagMatches: existing.etag };
  const res = await bucket.put(key, JSON.stringify(value), {
    onlyIf,
    httpMetadata: JSON_HTTP_METADATA,
  });
  return res ? { ok: true, etag: res.etag } : { ok: false, status: 412 };
};
