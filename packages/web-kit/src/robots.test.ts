import { describe, expect, it } from 'vitest';

import { isIndexable, NOINDEX, robotsTxt, sitemapXml } from './robots.js';

describe('isIndexable', () => {
  it.each([
    ['production', true],
    ['dev', false],
    ['', false],
    [undefined, false],
    ['prod', false],
  ])('%s -> %s', (mode, expected) => {
    expect(isIndexable(mode)).toBe(expected);
  });
});

describe('robotsTxt', () => {
  it('disallows everything when not indexable', () => {
    expect(robotsTxt(false)).toBe('User-agent: *\nDisallow: /\n');
  });

  it('allows everything when indexable', () => {
    expect(robotsTxt(true)).toBe('User-agent: *\nAllow: /\n');
  });

  it('points an indexable site at its sitemap', () => {
    expect(robotsTxt(true, 'https://panote.io/sitemap.xml')).toBe(
      'User-agent: *\nAllow: /\n\nSitemap: https://panote.io/sitemap.xml\n',
    );
  });

  it('never names a sitemap when not indexable', () => {
    expect(robotsTxt(false, 'https://panote.dev/sitemap.xml')).toBe('User-agent: *\nDisallow: /\n');
  });

  it('pins the header value', () => {
    expect(NOINDEX).toBe('noindex, nofollow');
  });
});

describe('sitemapXml', () => {
  it('lists each path as an absolute URL under the origin', () => {
    expect(sitemapXml('https://panote.io', ['/', '/privacy'])).toBe(
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
        '  <url><loc>https://panote.io/</loc></url>\n' +
        '  <url><loc>https://panote.io/privacy</loc></url>\n' +
        '</urlset>\n',
    );
  });

  it('is an empty urlset with no paths', () => {
    expect(sitemapXml('https://panote.dev', [])).toBe(
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
        '</urlset>\n',
    );
  });

  it('escapes the URL for XML', () => {
    expect(sitemapXml('https://panote.io', ['/a?b=1&c=2'])).toContain(
      '<loc>https://panote.io/a?b=1&amp;c=2</loc>',
    );
  });
});
