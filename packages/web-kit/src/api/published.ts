import {
  PANO_PATTERN,
  PublishedTourSchema,
  pubTourKey,
  SlugPointerSchema,
  SlugRecordSchema,
  storedSlugKey,
  type PublishedTour,
  type SlugRecord,
} from '@internal/contracts';
import { z } from 'zod';

import { ApiError, parseWith, readJson, type FetchLike } from './http.js';

/** What a share link resolves to, read straight from the CDN (plan 3.2). */
export type PublishedTourResult =
  | { kind: 'tour'; tour: PublishedTour }
  /** A live alias of the same tour: navigate to `/s/<slug>`. */
  | { kind: 'redirect'; slug: string }
  /** 404 at any step, an expired alias, or an alias whose target another tour holds. */
  | { kind: 'unavailable' };

export interface LoadPublishedTourOptions {
  fetch?: FetchLike;
  signal?: AbortSignal;
  now?: () => number;
  /**
   * The website Worker's `#pn-boot` payload (`{slug, record, tour}`), unvalidated. Used instead of the
   * two CDN reads when it is for this slug and passes the same schemas; otherwise ignored.
   */
  boot?: unknown;
}

const BootDataSchema = z.object({
  slug: z.string(),
  record: SlugPointerSchema,
  tour: PublishedTourSchema,
});

function tourFromBoot(boot: unknown, slug: string): PublishedTour | null {
  const parsed = BootDataSchema.safeParse(boot);
  if (!parsed.success) return null;
  const { slug: bootSlug, record, tour } = parsed.data;
  if (bootSlug !== slug || !PANO_PATTERN.test(record.tourId)) return null;
  return tour.tourId === record.tourId ? tour : null;
}

const UNAVAILABLE = { kind: 'unavailable' } as const;

/**
 * Resolve a share-link slug: `slugs/<slug>.json`, then `pub/tours/<tourId>.json`.
 * Mirrors the website Worker's alias rule so local dev without the Worker behaves the same.
 * Matching `boot` data short-circuits both reads.
 */
export async function loadPublishedTour(
  cdnBase: string,
  slug: string,
  opts: LoadPublishedTourOptions = {},
): Promise<PublishedTourResult> {
  const booted = opts.boot == null ? null : tourFromBoot(opts.boot, slug);
  if (booted) return { kind: 'tour', tour: booted };

  const doFetch: FetchLike = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const now = opts.now ?? Date.now;

  async function get<S extends z.ZodTypeAny>(key: string, schema: S): Promise<z.output<S> | null> {
    const url = `${cdnBase}${key}`;
    const init: RequestInit = {};
    if (opts.signal) init.signal = opts.signal;
    const res = await doFetch(url, init);
    if (res.status === 404) return null;
    const body = await readJson(res);
    if (!res.ok) throw new ApiError(res.status, body);
    return parseWith(schema, url, body);
  }
  const readSlug = async (s: string): Promise<SlugRecord | null> => {
    const key = storedSlugKey(s);
    return key ? get(key, SlugRecordSchema) : null;
  };

  const record = await readSlug(slug);
  if (!record) return UNAVAILABLE;
  if (record.kind === 'redirect') {
    const expiresAt = Date.parse(record.expiresAt);
    if (!(expiresAt > now()) || record.redirect === slug) return UNAVAILABLE;
    const target = await readSlug(record.redirect);
    // Never follow an alias onto a slug another tour has since claimed.
    if (target?.kind !== 'tour' || target.tourId !== record.tourId) return UNAVAILABLE;
    return { kind: 'redirect', slug: record.redirect };
  }
  if (!PANO_PATTERN.test(record.tourId)) return UNAVAILABLE;
  const tour = await get(pubTourKey(record.tourId), PublishedTourSchema);
  if (!tour || tour.tourId !== record.tourId) return UNAVAILABLE;
  return { kind: 'tour', tour };
}
