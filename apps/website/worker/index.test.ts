import { env, SELF } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import worker, { BOOT_BUDGET_MS } from './index.js';
import { parseSlugPath } from './redirect.js';

const ORIGIN = 'https://panote.test';
const TOUR = 'tour-a';
const FUTURE = new Date(Date.now() + 86_400_000).toISOString();
const PAST = new Date(Date.now() - 1000).toISOString();

const live = (tourId: string) => ({ v: 1, kind: 'tour', tourId });
const alias = (redirect: string, expiresAt = FUTURE, tourId = TOUR) => ({
  v: 1,
  kind: 'redirect',
  tourId,
  redirect,
  expiresAt,
});

const putSlug = (slug: string, body: unknown) =>
  env.BUCKET.put(`slugs/${slug}.json`, typeof body === 'string' ? body : JSON.stringify(body));

const CDN = 'https://cdn.test/';
// The shape `vite build` writes, including the cdnPreconnect plugin's link.
const PAGE =
  '<!doctype html><html lang="en"><head><meta charset="UTF-8" /><title>panote</title>' +
  '<script type="module" crossorigin src="/assets/index-x.js"></script>' +
  `<link rel="preconnect" href="https://cdn.test" crossorigin data-cdn-base="${CDN}">` +
  '</head><body><div id="root"></div></body></html>';

const assets = {
  fetch: vi.fn(
    async (_request: Request) =>
      new Response(PAGE, {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8', ETag: '"abc"' },
      }),
  ),
};

async function call(path: string, init?: RequestInit, vars: Partial<Env> = {}): Promise<Response> {
  const request = new Request(`${ORIGIN}${path}`, init);
  return worker.fetch(request as Request<unknown, IncomingRequestCfProperties>, {
    ...env,
    ASSETS: assets as unknown as Fetcher,
    ...vars,
  });
}

async function clearBucket() {
  const listed = await env.BUCKET.list();
  await Promise.all(listed.objects.map((o) => env.BUCKET.delete(o.key)));
}

beforeEach(async () => {
  await clearBucket();
  assets.fetch.mockClear();
});
afterEach(clearBucket);

describe('parseSlugPath', () => {
  it.each([
    ['/s/old-name', { slug: 'old-name', embed: false }],
    ['/s/old-name/embed', { slug: 'old-name', embed: true }],
    ['/s/old-name/embed/', { slug: 'old-name', embed: true }],
    ['/s/old-name/other', null],
    ['/s/', null],
    ['/privacy', null],
  ])('%s', (path, expected) => {
    expect(parseSlugPath(path)).toEqual(expected);
  });
});

describe('slug alias redirects', () => {
  beforeEach(async () => {
    await putSlug('old-name', alias('new-name'));
    await putSlug('new-name', live(TOUR));
  });

  it('308s a valid alias to the new slug, uncached', async () => {
    const res = await call('/s/old-name');
    expect(res.status).toBe(308);
    expect(res.headers.get('Location')).toBe('/s/new-name');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(assets.fetch).not.toHaveBeenCalled();
  });

  it.each(['/s/old-name/embed', '/s/old-name/embed/'])(
    '308s %s to the new embed, keeping the query',
    async (path) => {
      const res = await call(`${path}?pano=hall-1&x=2`);
      expect(res.status).toBe(308);
      expect(res.headers.get('Location')).toBe('/s/new-name/embed?pano=hall-1&x=2');
      expect(res.headers.get('Cache-Control')).toBe('no-store');
    },
  );

  it('redirects HEAD too (curl -I)', async () => {
    const res = await call('/s/old-name', { method: 'HEAD' });
    expect(res.status).toBe(308);
  });

  it('never redirects a non-GET request', async () => {
    const res = await call('/s/old-name', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(assets.fetch).toHaveBeenCalledOnce();
  });
});

describe('falls through to the SPA', () => {
  const fallsThrough = async (path: string) => {
    const res = await call(path);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(PAGE);
    expect(assets.fetch).toHaveBeenCalledOnce();
  };

  it('for a live pointer', async () => {
    await putSlug('new-name', live(TOUR));
    await fallsThrough('/s/new-name');
  });

  it('for a missing slug', () => fallsThrough('/s/nobody-here/embed'));

  it('for an expired alias', async () => {
    await putSlug('old-name', alias('new-name', PAST));
    await putSlug('new-name', live(TOUR));
    await fallsThrough('/s/old-name');
  });

  it('for an alias with an unparseable expiry', async () => {
    await putSlug('old-name', alias('new-name', 'soon'));
    await putSlug('new-name', live(TOUR));
    await fallsThrough('/s/old-name');
  });

  it('for an alias whose target another tour now holds', async () => {
    await putSlug('old-name', alias('new-name'));
    await putSlug('new-name', live('tour-b'));
    await fallsThrough('/s/old-name');
  });

  it('for an alias whose target is gone or is itself an alias', async () => {
    await putSlug('old-name', alias('new-name'));
    await fallsThrough('/s/old-name');
    assets.fetch.mockClear();
    await putSlug('new-name', alias('newer-name'));
    await putSlug('newer-name', live(TOUR));
    await fallsThrough('/s/old-name');
  });

  it('for an alias pointing at itself', async () => {
    await putSlug('old-name', alias('old-name'));
    await fallsThrough('/s/old-name');
  });

  it('for an invalid slug, without touching R2', async () => {
    const get = vi.spyOn(env.BUCKET, 'get');
    await fallsThrough('/s/Old..Name');
    assets.fetch.mockClear();
    await fallsThrough('/s/UPPER');
    expect(get).not.toHaveBeenCalled();
  });

  it('for a corrupt slug record', async () => {
    await putSlug('old-name', '{not json');
    await fallsThrough('/s/old-name');
  });

  it('when R2 throws', async () => {
    vi.spyOn(env.BUCKET, 'get').mockRejectedValue(new Error('r2 down'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await fallsThrough('/s/old-name');
  });

  it('for a path deeper than the embed', () => fallsThrough('/s/old-name/embed/extra'));
});

const bundle = (over: Record<string, unknown> = {}) => ({
  v: 1,
  tourId: TOUR,
  title: 'Old town',
  visibility: 'public',
  slug: 'new-name',
  publishedAt: '2026-09-20T00:00:00Z',
  settings: { controls: 'bottom', showMap: true, showCompass: true, autoRotate: false },
  startPanoId: 'pano-1',
  scenes: ['pano-1', 'pano-2'].map((panoId) => ({
    panoId,
    config: { panoId, title: panoId, hotspots: [] },
  })),
  ...over,
});
const manifest = (pano: string) => ({
  pano,
  faceSize: 1024,
  tileSize: 512,
  maxLevel: 1,
  faces: ['px', 'nx', 'py', 'ny', 'pz', 'nz'],
  quality: 70,
  format: 'webp',
  version: 'v7',
});
const putJson = (key: string, body: unknown) => env.BUCKET.put(key, JSON.stringify(body));

async function publish(tour = bundle()) {
  await putSlug('new-name', live(TOUR));
  await putJson(`pub/tours/${TOUR}.json`, tour);
  await putJson('tiles/pano-1/manifest.json', manifest('pano-1'));
  await putJson('tiles/pano-2/manifest.json', manifest('pano-2'));
}

const bootOf = (html: string): unknown => {
  const match = /<script type="application\/json" id="pn-boot">(.*?)<\/script>/.exec(html);
  return match ? JSON.parse(match[1]!) : null;
};
const preloadsOf = (html: string): string[] =>
  [...html.matchAll(/<link rel="preload"[^>]*>/g)].map((m) => m[0]);
const hrefOf = (tag: string): string => /href="([^"]*)"/.exec(tag)![1]!;
const l0 = (pano: string) =>
  ['px', 'nx', 'py', 'ny', 'pz', 'nz'].map((f) => `${CDN}tiles/${pano}/v7/0/${f}/0-0.webp`);

describe('primes a live tour page', () => {
  beforeEach(() => publish());

  it('inlines the tour, its title and preloads for the start scene', async () => {
    const res = await call('/s/new-name');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<title>Old town · panote</title>');
    expect(bootOf(html)).toEqual({ slug: 'new-name', record: live(TOUR), tour: bundle() });
    expect(preloadsOf(html).map(hrefOf)).toEqual([
      `${CDN}tiles/pano-1/manifest.json`,
      ...l0('pano-1'),
    ]);
    expect(html).not.toContain('name="robots"');
  });

  it('preloads as CORS fetches, so the viewer reuses them', async () => {
    const preloads = preloadsOf(await (await call('/s/new-name')).text());
    expect(preloads).toHaveLength(7);
    for (const tag of preloads) {
      expect(tag).toMatch(/ as="fetch"/);
      expect(tag).toMatch(/ crossorigin>$/);
    }
  });

  it('drops the ETag and never answers 304', async () => {
    const res = await call('/s/new-name', {
      headers: {
        'If-None-Match': '"abc"',
        'If-Modified-Since': 'Sat, 10 Oct 2026 00:00:00 GMT',
        Accept: 'text/html',
      },
    });
    expect(res.headers.get('ETag')).toBeNull();
    const forwarded = assets.fetch.mock.calls[0]![0];
    expect(forwarded.headers.get('If-None-Match')).toBeNull();
    expect(forwarded.headers.get('If-Modified-Since')).toBeNull();
    expect(forwarded.headers.get('Accept')).toBe('text/html');
  });

  it('preloads the ?pano= scene when the tour has it', async () => {
    const html = await (await call('/s/new-name/embed?pano=pano-2')).text();
    expect(preloadsOf(html).map(hrefOf)).toEqual([
      `${CDN}tiles/pano-2/manifest.json`,
      ...l0('pano-2'),
    ]);
    const other = await (await call('/s/new-name?pano=nope')).text();
    expect(preloadsOf(other).map(hrefOf)[0]).toBe(`${CDN}tiles/pano-1/manifest.json`);
  });

  it('skips preloads for an embed pinned to an unknown scene', async () => {
    const html = await (await call('/s/new-name/embed?pano=nope')).text();
    expect(preloadsOf(html)).toEqual([]);
    expect(bootOf(html)).not.toBeNull();
  });

  it('keeps the tour data but skips preloads without a manifest', async () => {
    await env.BUCKET.delete('tiles/pano-1/manifest.json');
    const html = await (await call('/s/new-name')).text();
    expect(preloadsOf(html)).toEqual([]);
    expect(bootOf(html)).not.toBeNull();
  });

  it('marks an unlisted tour noindex', async () => {
    await putJson(`pub/tours/${TOUR}.json`, bundle({ visibility: 'unlisted' }));
    const html = await (await call('/s/new-name')).text();
    expect(html).toContain('<meta name="robots" content="noindex">');
  });

  it('escapes markup in the title, in the page and in the boot data', async () => {
    const title = '</script><script>alert(1)</script>';
    await putJson(`pub/tours/${TOUR}.json`, bundle({ title }));
    const html = await (await call('/s/new-name')).text();
    expect(html).not.toContain('<script>alert(1)');
    expect(html).toContain('<title>&lt;/script&gt;&lt;script&gt;alert(1)&lt;/script&gt; · panote');
    expect(html).toContain('\\u003c/script>\\u003cscript>alert(1)\\u003c/script>');
    expect(bootOf(html)).toMatchObject({ tour: { title } });
  });

  it('leaves HEAD untouched', async () => {
    const res = await call('/s/new-name', { method: 'HEAD' });
    expect(await res.text()).toBe(PAGE);
  });

  it('serves the plain page when the tour read fails', async () => {
    const get = env.BUCKET.get.bind(env.BUCKET);
    vi.spyOn(env.BUCKET, 'get').mockImplementation(async (key: string) => {
      if (key.startsWith('pub/')) throw new Error('r2 down');
      return get(key);
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await call('/s/new-name');
    expect(await res.text()).toBe(PAGE);
    expect(res.headers.get('ETag')).toBe('"abc"');
  });

  it.each([
    ['missing', null],
    ['invalid', { v: 1 }],
    ['of another tour', bundle({ tourId: 'tour-b' })],
  ])('serves the plain page when the bundle is %s', async (_name, body) => {
    if (body === null) await env.BUCKET.delete(`pub/tours/${TOUR}.json`);
    else await putJson(`pub/tours/${TOUR}.json`, body);
    expect(await (await call('/s/new-name')).text()).toBe(PAGE);
  });

  it.each([
    ['a 404, even with an HTML body', 404, 'text/html; charset=utf-8'],
    ['a 200 that is not HTML', 200, 'text/plain'],
  ])('leaves %s alone', async (_name, status, type) => {
    assets.fetch.mockResolvedValueOnce(
      new Response(PAGE, { status, headers: { 'Content-Type': type, ETag: '"abc"' } }),
    );
    const res = await call('/s/new-name');
    expect(res.status).toBe(status);
    expect(await res.text()).toBe(PAGE);
    expect(res.headers.get('ETag')).toBe('"abc"');
  });

  it('serves the plain page when the R2 reads outlast the budget', async () => {
    const get = env.BUCKET.get.bind(env.BUCKET);
    vi.spyOn(env.BUCKET, 'get').mockImplementation((key: string) =>
      key.startsWith('pub/') ? new Promise<never>(() => {}) : get(key),
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const started = Date.now();
    const res = await call('/s/new-name');
    expect(await res.text()).toBe(PAGE);
    expect(Date.now() - started).toBeLessThan(BOOT_BUDGET_MS + 1500);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('serves the plain page when the rewriter cannot be set up', async () => {
    vi.spyOn(HTMLRewriter.prototype, 'transform').mockImplementation(() => {
      throw new Error('no rewriter');
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await call('/s/new-name');
    expect(await res.text()).toBe(PAGE);
  });
});

describe('X-Robots-Tag', () => {
  beforeEach(async () => {
    await putSlug('old-name', alias('new-name'));
    await putSlug('new-name', live(TOUR));
  });

  it('tags the 308 and the passed-through SPA on dev (INDEXABLE=false)', async () => {
    expect(env.INDEXABLE).toBe('false');
    expect((await call('/s/old-name')).headers.get('X-Robots-Tag')).toBe('noindex, nofollow');
    const page = await call('/s/new-name');
    expect(await page.text()).toBe(PAGE);
    expect(page.headers.get('X-Robots-Tag')).toBe('noindex, nofollow');
  });

  it('fails safe when the var is missing', async () => {
    const res = await call('/s/new-name', undefined, { INDEXABLE: undefined as unknown as string });
    expect(res.headers.get('X-Robots-Tag')).toBe('noindex, nofollow');
  });

  it('leaves production responses untouched (INDEXABLE=true)', async () => {
    const prod = { INDEXABLE: 'true' };
    const redirect = await call('/s/old-name', undefined, prod);
    expect(redirect.status).toBe(308);
    expect(redirect.headers.get('X-Robots-Tag')).toBeNull();
    expect((await call('/s/new-name', undefined, prod)).headers.get('X-Robots-Tag')).toBeNull();
  });
});

describe('routing through the assets router', () => {
  it('serves non-/s paths from assets without running the script', async () => {
    await putSlug('privacy', alias('new-name'));
    const res = await SELF.fetch(`${ORIGIN}/privacy`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
  });

  it('serves the dev robots.txt as a file, not the SPA fallback', async () => {
    const res = await SELF.fetch(`${ORIGIN}/robots.txt`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(await res.text()).toBe('User-agent: *\nDisallow: /\n');
  });

  it('primes the built index.html, using the CDN root Vite wrote into it', async () => {
    await publish();
    const html = await (await SELF.fetch(`${ORIGIN}/s/new-name`)).text();
    expect(html).toContain('<script type="module"');
    expect(html).toContain('<title>Old town · panote</title>');
    expect(preloadsOf(html).map(hrefOf)).toEqual([
      'https://cdn.panote.dev/tiles/pano-1/manifest.json',
      ...l0('pano-1').map((u) => u.replace(CDN, 'https://cdn.panote.dev/')),
    ]);
  });

  it('runs the script first for /s/*', async () => {
    await putSlug('old-name', alias('new-name'));
    await putSlug('new-name', live(TOUR));
    const res = await SELF.fetch(`${ORIGIN}/s/old-name?pano=p1`, { redirect: 'manual' });
    expect(res.status).toBe(308);
    expect(res.headers.get('Location')).toBe('/s/new-name?pano=p1');
  });
});
