/** The `X-Robots-Tag` value every non-production response carries. */
export const NOINDEX = 'noindex, nofollow';

/** Only an explicit production build is indexable; any other or missing mode counts as dev. */
export const isIndexable = (mode: string | undefined): boolean => mode === 'production';

/**
 * `robots.txt` for the site root. Dev disallows everything, but `X-Robots-Tag` is the
 * real guard: a disallowed URL can still be indexed from links, just not crawled. An
 * indexable site may point crawlers at its sitemap (an absolute URL); dev never does.
 */
export function robotsTxt(indexable: boolean, sitemapUrl?: string): string {
  if (!indexable) return 'User-agent: *\nDisallow: /\n';
  return `User-agent: *\nAllow: /\n${sitemapUrl ? `\nSitemap: ${sitemapUrl}\n` : ''}`;
}

const escapeXml = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * `sitemap.xml` listing `paths` (each starting with `/`) under `origin`. Pass no paths off
 * production: the file still exists, so the URL never falls back to the SPA, but it names
 * nothing for a crawler to pick up.
 */
export function sitemapXml(origin: string, paths: readonly string[]): string {
  const urls = paths.map(
    (path) => `  <url><loc>${escapeXml(new URL(path, origin).href)}</loc></url>\n`,
  );
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    urls.join('') +
    '</urlset>\n'
  );
}
