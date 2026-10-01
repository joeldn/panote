import { SlugRecordSchema, storedSlugKey, type SlugRecord } from '@internal/contracts';

/** `/s/<slug>` or `/s/<slug>/embed[/]`; anything deeper is left to the SPA. */
const SLUG_PATH = /^\/s\/([^/]+)(\/embed\/?)?$/;

export interface SlugPath {
  slug: string;
  embed: boolean;
}

export function parseSlugPath(pathname: string): SlugPath | null {
  const match = SLUG_PATH.exec(pathname);
  if (!match) return null;
  return { slug: match[1]!, embed: match[2] !== undefined };
}

type SlugReader = Pick<R2Bucket, 'get'>;

async function readSlug(bucket: SlugReader, slug: string): Promise<SlugRecord | null> {
  // storedSlugKey is the traversal guard: an invalid slug never reaches R2.
  const key = storedSlugKey(slug);
  if (!key) return null;
  const object = await bucket.get(key);
  if (!object) return null;
  const parsed = SlugRecordSchema.safeParse(await object.json().catch(() => null));
  return parsed.success ? parsed.data : null;
}

/**
 * The relative path a slug alias should 308 to, or null to fall through to the SPA.
 * Only an unexpired alias whose target is still the SAME tour's live slug redirects.
 */
export async function resolveSlugRedirect(
  url: URL,
  bucket: SlugReader,
  now: number = Date.now(),
): Promise<string | null> {
  const path = parseSlugPath(url.pathname);
  if (!path) return null;
  const record = await readSlug(bucket, path.slug);
  if (record?.kind !== 'redirect') return null;
  const expiresAt = Date.parse(record.expiresAt);
  if (!(expiresAt > now) || record.redirect === path.slug) return null;
  const target = await readSlug(bucket, record.redirect);
  // A target slug released and claimed by another tour must never receive this traffic.
  if (target?.kind !== 'tour' || target.tourId !== record.tourId) return null;
  // Relative, so the redirect never depends on the host the request arrived on.
  return `/s/${record.redirect}${path.embed ? '/embed' : ''}${url.search}`;
}
