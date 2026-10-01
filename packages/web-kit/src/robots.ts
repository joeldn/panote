/** The `X-Robots-Tag` value every non-production response carries. */
export const NOINDEX = 'noindex, nofollow';

/** Only an explicit production build is indexable; any other or missing mode counts as dev. */
export const isIndexable = (mode: string | undefined): boolean => mode === 'production';

/**
 * `robots.txt` for the site root. Dev disallows everything, but `X-Robots-Tag` is the
 * real guard: a disallowed URL can still be indexed from links, just not crawled.
 */
export function robotsTxt(indexable: boolean): string {
  return `User-agent: *\n${indexable ? 'Allow: /' : 'Disallow: /'}\n`;
}
