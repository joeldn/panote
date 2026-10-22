import { env, SELF } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import worker, { BOOT_BUDGET_MS, BOT_BOOT_BUDGET_MS } from './index.js';
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
// index.html's site-wide description and link preview tags, as written there. The `&amp;`
// checks they go back out exactly as they came, not escaped twice.
const SITE_METAS = [
  '<meta name="description" content="Tours &amp; panoramas" />',
  '<meta property="og:title" content="panote" />',
  `<meta property="og:image" content="${ORIGIN}/og.jpg" />`,
  '<meta name="twitter:card" content="summary_large_image" />',
];
// The shape `vite build` writes, including the cdnPreconnect plugin's link.
const PAGE =
  '<!doctype html><html lang="en"><head><meta charset="UTF-8" /><title>panote</title>' +
  '<meta name="theme-color" content="#faf8f4" />' +
  SITE_METAS.join('') +
  '<script type="module" crossorigin src="/assets/index-x.js"></script>' +
  `<link rel="preconnect" href="https://cdn.test" crossorigin data-cdn-base="${CDN}">` +
  '</head><body><div id="root"></div></body></html>';

// What a live tour page streams when the R2 reads give nothing to inline: the plain page,
// with its title and site-wide preview tags moved to the end of the head (they are held
// back until the reads settle).
const PLAIN = SITE_METAS.reduce((page, tag) => page.replace(tag, ''), PAGE)
  .replace('<title>panote</title>', '')
  .replace(
    '</head>',
    `<title>panote</title>${SITE_METAS.map((tag) => tag.replace(' />', '>')).join('')}</head>`,
  );

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

/**
 * An ASSETS binding whose fetch fails. Not a vi.fn: a mock attaches its own handler to
 * every promise it returns, which would hide an unhandled rejection from the test.
 */
const failingAssets = () =>
  ({ fetch: () => Promise.reject(new Error('assets down')) }) as unknown as Fetcher;

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
    expect(res.body).toBeNull();
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

  it('cancels the HTML it started fetching for the slug', async () => {
    const cancel = vi.fn();
    assets.fetch.mockResolvedValueOnce(
      new Response(new ReadableStream({ cancel }), {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      }),
    );
    const res = await call('/s/old-name');
    expect(res.status).toBe(308);
    expect(assets.fetch).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
  });

  it('still redirects, with nothing left unhandled, when that HTML fetch fails', async () => {
    const unhandled = vi.fn();
    addEventListener('unhandledrejection', unhandled);
    try {
      const held = holdReads('slugs/');
      const pending = call('/s/old-name', undefined, { ASSETS: failingAssets() });
      await sleep(20);
      held.release();
      expect((await pending).status).toBe(308);
      await sleep(20);
    } finally {
      removeEventListener('unhandledrejection', unhandled);
    }
    expect(unhandled).not.toHaveBeenCalled();
  });

  it('never redirects a non-GET request', async () => {
    const res = await call('/s/old-name', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(assets.fetch).toHaveBeenCalledOnce();
  });
});

describe('falls through to the SPA', () => {
  const fallsThrough = async (path: string, body = PAGE) => {
    const res = await call(path);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(body);
    expect(assets.fetch).toHaveBeenCalledOnce();
  };

  it('for a live pointer with nothing to inline', async () => {
    await putSlug('new-name', live(TOUR));
    await fallsThrough('/s/new-name', PLAIN);
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
const metasOf = (html: string): string[] =>
  [...html.matchAll(/<meta (?:property|name)="(?:og:|twitter:|description")[^>]*>/g)].map(
    (m) => m[0],
  );
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

  it('writes each preload tag exactly as the viewer fetches it', async () => {
    const html = await (await call('/s/new-name')).text();
    expect(preloadsOf(html)).toEqual(
      [`${CDN}tiles/pano-1/manifest.json`, ...l0('pano-1')].map(
        (url) => `<link rel="preload" as="fetch" href="${url}" crossorigin>`,
      ),
    );
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
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await call('/s/new-name');
    expect(await res.text()).toBe(PLAIN);
    expect(error).toHaveBeenCalledWith('tour boot read failed', expect.any(Error));
  });

  it.each([
    ['missing', null],
    ['invalid', { v: 1 }],
    ['of another tour', bundle({ tourId: 'tour-b' })],
  ])('serves the plain page when the bundle is %s', async (_name, body) => {
    if (body === null) await env.BUCKET.delete(`pub/tours/${TOUR}.json`);
    else await putJson(`pub/tours/${TOUR}.json`, body);
    expect(await (await call('/s/new-name')).text()).toBe(PLAIN);
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
    expect(await res.text()).toBe(PLAIN);
    // A literal bound: one derived from the budget would pass however far it was raised.
    expect(BOOT_BUDGET_MS).toBeLessThanOrEqual(500);
    expect(Date.now() - started).toBeLessThan(2000);
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

const sleep = (ms: number) => new Promise<null>((resolve) => setTimeout(() => resolve(null), ms));

async function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  const late = sleep(ms).then(() => {
    throw new Error(`not settled within ${ms}ms`);
  });
  return Promise.race([promise, late]);
}

/** Holds every R2 read under `prefix` open until `release()`. */
function holdReads(prefix: string) {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  const get = env.BUCKET.get.bind(env.BUCKET);
  const spy = vi.spyOn(env.BUCKET, 'get').mockImplementation(async (key: string) => {
    if (key.startsWith(prefix)) await released;
    return get(key);
  });
  return { release, spy };
}

/** The body as two parts: what arrived before `release()` (once it stalls), and the rest. */
async function readAround(body: ReadableStream<Uint8Array>, release: () => void) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let before = '';
  let next = reader.read();
  for (;;) {
    const chunk = await Promise.race([next, sleep(100)]);
    if (!chunk) break;
    if (chunk.done) return { before, after: '' };
    before += decoder.decode(chunk.value, { stream: true });
    next = reader.read();
  }
  release();
  let after = '';
  for (let chunk = await next; !chunk.done; chunk = await reader.read()) {
    after += decoder.decode(chunk.value, { stream: true });
  }
  return { before, after };
}

describe('streams the page around the R2 reads', () => {
  beforeEach(() => publish());

  it('sends the head with the app script and CDN preconnect before the tour read lands', async () => {
    const held = holdReads('pub/');
    const res = await within(call('/s/new-name'), 1000);
    expect(res.status).toBe(200);
    expect(res.headers.get('ETag')).toBeNull();
    const { before, after } = await readAround(res.body!, held.release);
    expect(before).toContain(
      '<script type="module" crossorigin src="/assets/index-x.js"></script>',
    );
    expect(before).toContain(`data-cdn-base="${CDN}">`);
    for (const late of ['<title>', 'og:', 'twitter:', 'pn-boot', 'rel="preload"', '</head>']) {
      expect(before).not.toContain(late);
    }
    const html = before + after;
    expect(bootOf(html)).toEqual({ slug: 'new-name', record: live(TOUR), tour: bundle() });
    expect(html.match(/<title>/g)).toEqual(['<title>']);
    expect(html).toContain('<title>Old town · panote</title>');
    expect(preloadsOf(html)).toHaveLength(7);
    expect(metasOf(html)).toHaveLength(7);
  });

  it('puts the boot data and preloads in the head, so they parse before the app script runs', async () => {
    // A module script runs only once the whole document has parsed, and this is in <head>.
    const html = await (await call('/s/new-name')).text();
    const headEnd = html.indexOf('</head>');
    const script = html.indexOf('<script type="module"');
    for (const tag of [...preloadsOf(html), ...metasOf(html), 'id="pn-boot"', '<title>']) {
      const at = html.indexOf(tag);
      expect(at).toBeGreaterThan(script);
      expect(at).toBeLessThan(headEnd);
    }
  });

  it('starts the HTML fetch while the slug is still being read', async () => {
    const held = holdReads('slugs/');
    const pending = call('/s/new-name');
    await sleep(50);
    expect(assets.fetch).toHaveBeenCalledOnce();
    held.release();
    expect(bootOf(await (await pending).text())).not.toBeNull();
  });

  it('reads the tour while the HTML is still being fetched', async () => {
    let serve!: () => void;
    const served = new Promise<void>((resolve) => (serve = resolve));
    assets.fetch.mockImplementationOnce(async () => {
      await served;
      return new Response(PAGE, { status: 200, headers: { 'Content-Type': 'text/html' } });
    });
    const get = vi.spyOn(env.BUCKET, 'get');
    const pending = call('/s/new-name');
    await sleep(50);
    expect(get).toHaveBeenCalledWith(`pub/tours/${TOUR}.json`);
    serve();
    expect(bootOf(await (await pending).text())).not.toBeNull();
  });

  it('reads a ?pano= scene manifest alongside the tour, once', async () => {
    const held = holdReads('pub/');
    const res = await within(call('/s/new-name/embed?pano=pano-2'), 1000);
    await sleep(50);
    expect(held.spy).toHaveBeenCalledWith('tiles/pano-2/manifest.json');
    held.release();
    const html = await res.text();
    expect(preloadsOf(html).map(hrefOf)).toEqual([
      `${CDN}tiles/pano-2/manifest.json`,
      ...l0('pano-2'),
    ]);
    const reads = held.spy.mock.calls.filter(([key]) => key === 'tiles/pano-2/manifest.json');
    expect(reads).toHaveLength(1);
  });

  it('serves the plain page when a read lands after the budget', async () => {
    const get = env.BUCKET.get.bind(env.BUCKET);
    vi.spyOn(env.BUCKET, 'get').mockImplementation(async (key: string) => {
      if (key.startsWith('pub/')) await sleep(BOOT_BUDGET_MS + 150);
      return get(key);
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await within(call('/s/new-name'), BOOT_BUDGET_MS - 100);
    expect(await res.text()).toBe(PLAIN);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('serves the plain page when priming throws mid-stream', async () => {
    const stringify = JSON.stringify.bind(JSON);
    vi.spyOn(JSON, 'stringify').mockImplementation((value: unknown, replacer, space) => {
      if ((value as { slug?: unknown } | null)?.slug === 'new-name') throw new Error('boom');
      return stringify(value, replacer as (string | number)[] | null, space);
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await call('/s/new-name');
    expect(await res.text()).toBe(PLAIN);
    expect(error).toHaveBeenCalledWith('tour page priming failed', expect.any(Error));
  });
});

const tag = (key: string, content: string) =>
  `<meta ${key.startsWith('og:') ? 'property' : 'name'}="${key}" content="${content}">`;
const DESCRIPTION = 'A 360° virtual tour · 2 scenes';
const textTags = (title = 'Old town', description = DESCRIPTION, url = `${ORIGIN}/s/new-name`) => [
  tag('description', description),
  tag('og:type', 'website'),
  tag('og:site_name', 'panote'),
  tag('og:title', title),
  tag('og:description', description),
  tag('og:url', url),
];
const previewTags = (pano = 'pano-1', alt = pano) => [
  tag('og:image', `${CDN}tiles/${pano}/v7/preview.webp`),
  tag('og:image:type', 'image/webp'),
  tag('og:image:width', '1024'),
  tag('og:image:height', '512'),
  tag('og:image:alt', alt),
  tag('twitter:card', 'summary_large_image'),
];

describe('link previews', () => {
  beforeEach(async () => {
    await publish();
    for (const pano of ['pano-1', 'pano-2']) {
      await putJson(`tiles/${pano}/manifest.json`, { ...manifest(pano), preview: true });
    }
  });

  it('describes a full tour with its equirect preview as a large image', async () => {
    const html = await (await call('/s/new-name')).text();
    expect(metasOf(html)).toEqual([...textTags(), ...previewTags()]);
  });

  it('writes the tags right after the title, ahead of the preloads and boot data', async () => {
    const html = await (await call('/s/new-name')).text();
    const tail = html.slice(html.indexOf('<title>'), html.indexOf('</head>'));
    expect(tail).toBe(
      '<title>Old town · panote</title>' +
        [...textTags(), ...previewTags()].join('') +
        preloadsOf(html).join('') +
        tail.slice(tail.indexOf('<script type="application/json"')),
    );
  });

  it('points og:url at the canonical page, without the query or the embed suffix', async () => {
    const html = await (await call('/s/new-name/embed/?pano=pano-2&utm_source=x')).text();
    expect(metasOf(html)).toEqual([...textTags(), ...previewTags('pano-2')]);
  });

  it('counts a single scene in the singular', async () => {
    await putJson(`pub/tours/${TOUR}.json`, bundle({ scenes: bundle().scenes.slice(0, 1) }));
    const html = await (await call('/s/new-name')).text();
    expect(html).toContain(tag('og:description', 'A 360° virtual tour · 1 scene'));
    expect(html).toContain(tag('description', 'A 360° virtual tour · 1 scene'));
  });

  it('describes a tour with no scenes without a count', async () => {
    await putJson(`pub/tours/${TOUR}.json`, bundle({ scenes: [] }));
    const html = await (await call('/s/new-name')).text();
    expect(metasOf(html)).toEqual([
      ...textTags('Old town', 'A 360° virtual tour'),
      tag('twitter:card', 'summary'),
    ]);
  });

  it('writes the card in the ?lang= language, and in the default otherwise', async () => {
    const tour = bundle({
      description: 'Three squares',
      languages: { default: 'en', others: ['de'] },
      i18n: { de: { title: 'Altstadt', description: 'Drei Plätze' } },
      scenes: bundle().scenes.map((s, i) =>
        i === 0 ? { ...s, config: { ...s.config, i18n: { de: { title: 'Platz' } } } } : s,
      ),
    });
    await putJson(`pub/tours/${TOUR}.json`, tour);
    const de = await (await call('/s/new-name?lang=de')).text();
    expect(de).toContain('<title>Altstadt · panote</title>');
    expect(metasOf(de)).toEqual([
      ...textTags('Altstadt', 'Drei Plätze'),
      ...previewTags('pano-1', 'Platz'),
    ]);
    // The SPA still gets the bundle as stored.
    expect(bootOf(de)).toEqual({ slug: 'new-name', record: live(TOUR), tour });
    for (const path of ['/s/new-name', '/s/new-name?lang=ja']) {
      const html = await (await call(path)).text();
      expect(metasOf(html)).toEqual([...textTags('Old town', 'Three squares'), ...previewTags()]);
    }
  });

  it("uses the tour's published description over the generated line", async () => {
    await putJson(`pub/tours/${TOUR}.json`, bundle({ description: 'Three squares at dusk.' }));
    const html = await (await call('/s/new-name')).text();
    expect(metasOf(html)).toEqual([
      ...textTags('Old town', 'Three squares at dusk.'),
      ...previewTags(),
    ]);
  });

  it('puts a multi-line description on one line, escaped', async () => {
    const description = '  Tom\'s "Café"\n\n<b>Harbour</b> &\t walls \r\n ';
    await putJson(`pub/tours/${TOUR}.json`, bundle({ description }));
    const html = await (await call('/s/new-name')).text();
    const line = 'Tom&#39;s &quot;Café&quot; &lt;b&gt;Harbour&lt;/b&gt; &amp; walls';
    expect(html).toContain(tag('description', line));
    expect(html).toContain(tag('og:description', line));
    expect(html).not.toContain('<b>');
  });

  it('turns control characters and NEL in a hand-written description into spaces', async () => {
    const description = 'Old\u0000town\u0085at\u001bdusk\u007f\u000b\u0085';
    await putJson(`pub/tours/${TOUR}.json`, bundle({ description }));
    const html = await (await call('/s/new-name')).text();
    expect(metasOf(html)).toEqual([...textTags('Old town', 'Old town at dusk'), ...previewTags()]);
  });

  it('falls back to the generated line for a description of only control characters', async () => {
    await putJson(`pub/tours/${TOUR}.json`, bundle({ description: '\u0001\u0085\u0000' }));
    const html = await (await call('/s/new-name')).text();
    expect(metasOf(html)).toEqual([...textTags(), ...previewTags()]);
  });

  it('falls back to the generated line for a blank description', async () => {
    await putJson(`pub/tours/${TOUR}.json`, bundle({ description: ' \n ' }));
    const html = await (await call('/s/new-name')).text();
    expect(metasOf(html)).toEqual([...textTags(), ...previewTags()]);
  });

  it('gives no image, never the mirrored cube face, without og.jpg or a preview', async () => {
    await putJson('tiles/pano-1/manifest.json', { ...manifest('pano-1'), format: 'jpg' });
    const html = await (await call('/s/new-name')).text();
    expect(metasOf(html)).toEqual([...textTags(), tag('twitter:card', 'summary')]);
    expect(html).not.toContain('og:image');
  });

  it('builds the preview URL for an unversioned manifest', async () => {
    const { version: _v, ...unversioned } = { ...manifest('pano-1'), preview: true };
    await putJson('tiles/pano-1/manifest.json', unversioned);
    const html = await (await call('/s/new-name')).text();
    expect(html).toContain(tag('og:image', `${CDN}tiles/pano-1/preview.webp`));
  });

  it('keeps the text tags but drops the image without a manifest', async () => {
    await env.BUCKET.delete('tiles/pano-1/manifest.json');
    const html = await (await call('/s/new-name')).text();
    expect(metasOf(html)).toEqual([...textTags(), tag('twitter:card', 'summary')]);
  });

  it('drops the image for an embed pinned to an unknown scene', async () => {
    const html = await (await call('/s/new-name/embed?pano=nope')).text();
    expect(metasOf(html)).toEqual([...textTags(), tag('twitter:card', 'summary')]);
  });

  it.each([
    ['not https', 'http://cdn.test/'],
    ['relative', '/cdn/'],
  ])('drops the image when the CDN root is %s', async (_name, base) => {
    assets.fetch.mockResolvedValueOnce(
      new Response(PAGE.replace(`data-cdn-base="${CDN}"`, `data-cdn-base="${base}"`), {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      }),
    );
    const html = await (await call('/s/new-name')).text();
    expect(metasOf(html)).toEqual([...textTags(), tag('twitter:card', 'summary')]);
  });

  it('keeps the previews on an unlisted tour, alongside its noindex', async () => {
    await putJson(`pub/tours/${TOUR}.json`, bundle({ visibility: 'unlisted' }));
    const html = await (await call('/s/new-name')).text();
    expect(html).toContain('<meta name="robots" content="noindex">');
    expect(metasOf(html)).toEqual([...textTags(), ...previewTags()]);
  });

  it('escapes quotes, markup, ampersands and keeps unicode in every value', async () => {
    const title = `Tom's "Café" <b>&amp;</b> 東京 🏠`;
    const scene = `Hall "A" & <i>B</i>`;
    const tour = bundle({ title });
    tour.scenes[0]!.config.title = scene;
    await putJson(`pub/tours/${TOUR}.json`, tour);
    const html = await (await call('/s/new-name')).text();
    expect(html).toContain(
      tag('og:title', 'Tom&#39;s &quot;Café&quot; &lt;b&gt;&amp;amp;&lt;/b&gt; 東京 🏠'),
    );
    expect(html).toContain(tag('og:image:alt', 'Hall &quot;A&quot; &amp; &lt;i&gt;B&lt;/i&gt;'));
    expect(html).not.toContain('<b>');
    expect(html).not.toContain('<i>');
  });

  it('keeps only the site-wide tags when the page is served plain', async () => {
    await env.BUCKET.delete(`pub/tours/${TOUR}.json`);
    const html = await (await call('/s/new-name')).text();
    expect(html).toBe(PLAIN);
    expect(metasOf(html)).toEqual(SITE_METAS.map((tag) => tag.replace(' />', '>')));
  });

  it("replaces the site-wide description and preview tags with the tour's own", async () => {
    const html = await (await call('/s/new-name')).text();
    expect(html).not.toContain('Tours &amp; panoramas');
    expect(html).not.toContain(`${ORIGIN}/og.jpg`);
    expect(html.match(/name="description"/g)).toHaveLength(1);
    expect(html.match(/property="og:title"/g)).toHaveLength(1);
    expect(html.match(/name="twitter:card"/g)).toHaveLength(1);
    // Not a preview tag: it stays where it was.
    expect(html).toContain('<meta name="theme-color" content="#faf8f4" />');
  });

  it('adds nothing when the reads outlast the budget', async () => {
    const get = env.BUCKET.get.bind(env.BUCKET);
    vi.spyOn(env.BUCKET, 'get').mockImplementation(async (key: string) => {
      if (key.startsWith('pub/')) await sleep(BOOT_BUDGET_MS + 150);
      return get(key);
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await within(call('/s/new-name'), BOOT_BUDGET_MS - 100);
    expect(await res.text()).toBe(PLAIN);
  });

  it('adds nothing for a slug with no live tour', async () => {
    const html = await (await call('/s/nobody-here')).text();
    expect(html).toBe(PAGE);
  });
});

const SLACK = 'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)';
const CHROME =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';
const as = (ua: string) => ({ headers: { 'User-Agent': ua } });

/** Delays every R2 read under `prefix` by `ms`; `forever` never answers. */
function slowReads(prefix: string, ms: number | 'forever') {
  const get = env.BUCKET.get.bind(env.BUCKET);
  return vi.spyOn(env.BUCKET, 'get').mockImplementation(async (key: string) => {
    if (key.startsWith(prefix)) {
      if (ms === 'forever') await new Promise<never>(() => {});
      else await sleep(ms);
    }
    return get(key);
  });
}

describe('link-preview crawlers', () => {
  beforeEach(async () => {
    await publish();
    for (const pano of ['pano-1', 'pano-2']) {
      await putJson(`tiles/${pano}/manifest.json`, { ...manifest(pano), preview: true });
    }
  });

  it('waits past the person budget for a slow tour read and gets the full tags', async () => {
    slowReads('pub/', BOOT_BUDGET_MS + 400);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const html = await (await call('/s/new-name', as(SLACK))).text();
    expect(metasOf(html)).toEqual([...textTags(), ...previewTags()]);
    expect(html).toContain('<title>Old town · panote</title>');
    expect(warn).not.toHaveBeenCalled();
  });

  it('waits for a slow manifest read too, so the card keeps its image', async () => {
    slowReads('tiles/', BOOT_BUDGET_MS + 400);
    const html = await (await call('/s/new-name', as('Twitterbot/1.0'))).text();
    expect(metasOf(html)).toEqual([...textTags(), ...previewTags()]);
  });

  it('keeps the person budget for a browser', async () => {
    slowReads('pub/', BOOT_BUDGET_MS + 400);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await within(call('/s/new-name', as(CHROME)), BOOT_BUDGET_MS + 300);
    expect(await res.text()).toBe(PLAIN);
    expect(warn).toHaveBeenCalledWith(
      `tour boot read took over ${BOOT_BUDGET_MS}ms; serving the plain page`,
    );
  });

  it(
    'gives up at the cap and serves the plain page when R2 never answers',
    async () => {
      // A literal bound: one derived from the cap would pass however far it was raised.
      expect(BOT_BOOT_BUDGET_MS).toBeLessThanOrEqual(5000);
      slowReads('pub/', 'forever');
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const started = Date.now();
      const res = await call('/s/new-name', as(SLACK));
      expect(await res.text()).toBe(PLAIN);
      const took = Date.now() - started;
      expect(took).toBeGreaterThanOrEqual(BOT_BOOT_BUDGET_MS - 50);
      expect(took).toBeLessThan(BOT_BOOT_BUDGET_MS + 3000);
      expect(warn).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledWith(
        `tour boot read took over ${BOT_BOOT_BUDGET_MS}ms; serving the plain page`,
      );
    },
    BOT_BOOT_BUDGET_MS + 6000,
  );

  it('serves the plain page at once when the tour read fails', async () => {
    const get = env.BUCKET.get.bind(env.BUCKET);
    vi.spyOn(env.BUCKET, 'get').mockImplementation(async (key: string) => {
      if (key.startsWith('pub/')) throw new Error('r2 down');
      return get(key);
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await within(call('/s/new-name', as(SLACK)), 1000);
    expect(await res.text()).toBe(PLAIN);
    expect(error).toHaveBeenCalledWith('tour boot read failed', expect.any(Error));
  });

  it('serves a crawler and a person the same page when R2 is quick', async () => {
    // Only the wait depends on the User-Agent, so a cache can't hand either the wrong shape.
    const bot = await call('/s/new-name', as(SLACK));
    const person = await call('/s/new-name', as(CHROME));
    expect(await bot.text()).toBe(await person.text());
    expect(bot.headers.get('Vary')).toBe(person.headers.get('Vary'));
  });

  it('still streams the head before the reads land', async () => {
    const held = holdReads('pub/');
    const res = await within(call('/s/new-name', as(SLACK)), 1000);
    const { before, after } = await readAround(res.body!, held.release);
    expect(before).toContain('<script type="module"');
    expect(before).not.toContain('og:');
    expect(metasOf(before + after)).toEqual([...textTags(), ...previewTags()]);
  });
});

// Kept apart from 'link previews' above: only the image tags, so the text tags can change freely.
describe('link preview image (og.jpg)', () => {
  const imageTags = (html: string) =>
    metasOf(html).filter((m) => m.includes('"og:image') || m.includes('"twitter:card"'));
  const ogTags = (url: string, alt: string) => [
    tag('og:image', url),
    tag('og:image:type', 'image/jpeg'),
    tag('og:image:width', '1200'),
    tag('og:image:height', '630'),
    tag('og:image:alt', alt),
    tag('twitter:card', 'summary_large_image'),
  ];

  beforeEach(async () => {
    await publish();
    for (const pano of ['pano-1', 'pano-2']) {
      await putJson(`tiles/${pano}/manifest.json`, { ...manifest(pano), preview: true, og: true });
    }
  });

  it('prefers the rendered 1200x630 JPEG over the equirect preview', async () => {
    const html = await (await call('/s/new-name')).text();
    expect(imageTags(html)).toEqual(ogTags(`${CDN}tiles/pano-1/v7/og.jpg`, 'pano-1'));
  });

  it('uses the scene a shared embed is pinned to', async () => {
    const html = await (await call('/s/new-name/embed?pano=pano-2')).text();
    expect(imageTags(html)).toEqual(ogTags(`${CDN}tiles/pano-2/v7/og.jpg`, 'pano-2'));
  });

  it('builds the og.jpg URL for an unversioned manifest', async () => {
    const { version: _v, ...unversioned } = { ...manifest('pano-1'), og: true };
    await putJson('tiles/pano-1/manifest.json', unversioned);
    const html = await (await call('/s/new-name')).text();
    expect(html).toContain(tag('og:image', `${CDN}tiles/pano-1/og.jpg`));
  });

  it('keeps the equirect preview for a pano tiled before og.jpg existed', async () => {
    await putJson('tiles/pano-1/manifest.json', { ...manifest('pano-1'), preview: true });
    const html = await (await call('/s/new-name')).text();
    expect(html).toContain(tag('og:image', `${CDN}tiles/pano-1/v7/preview.webp`));
    expect(html).toContain(tag('og:image:type', 'image/webp'));
    expect(html).not.toContain('og.jpg');
  });

  it('escapes the scene title in its alt text', async () => {
    const tour = bundle();
    tour.scenes[0]!.config.title = `Hall "A" & <i>B</i>`;
    await putJson(`pub/tours/${TOUR}.json`, tour);
    const html = await (await call('/s/new-name')).text();
    expect(html).toContain(tag('og:image:alt', 'Hall &quot;A&quot; &amp; &lt;i&gt;B&lt;/i&gt;'));
  });
});

describe('a failed HTML fetch', () => {
  it('is never left unhandled while the slug is still being read', async () => {
    await putSlug('new-name', live(TOUR));
    const unhandled = vi.fn();
    addEventListener('unhandledrejection', unhandled);
    try {
      const held = holdReads('slugs/');
      const settled = call('/s/new-name', undefined, { ASSETS: failingAssets() }).then(
        () => null,
        (err: unknown) => err,
      );
      // The fetch has already failed; the slug read is still out.
      await sleep(20);
      held.release();
      // Nothing to serve without the page: the request fails as an asset fetch would.
      expect(await settled).toEqual(new Error('assets down'));
      await sleep(20);
    } finally {
      removeEventListener('unhandledrejection', unhandled);
    }
    expect(unhandled).not.toHaveBeenCalled();
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
    expect(await page.text()).toBe(PLAIN);
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

  it('serves the dev sitemap.xml as a file that lists nothing', async () => {
    const res = await SELF.fetch(`${ORIGIN}/sitemap.xml`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('xml');
    const xml = await res.text();
    expect(xml).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    expect(xml).not.toContain('<url>');
  });

  it.each(['/favicon.ico', '/favicon.svg', '/apple-touch-icon.png', '/og.jpg'])(
    'serves %s as a file',
    async (path) => {
      const res = await SELF.fetch(`${ORIGIN}${path}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).not.toContain('text/html');
    },
  );

  it("gives the landing page the site's description and a dev-origin preview image", async () => {
    const html = await (await SELF.fetch(`${ORIGIN}/`)).text();
    expect(html).toMatch(/<meta\s+name="description"\s+content="Host 360° panorama tours/);
    expect(html).toContain('<meta property="og:image" content="https://panote.dev/og.jpg" />');
    expect(html).toContain('<meta name="theme-color" content="#faf8f4" />');
    expect(html).not.toContain('https://panote.io');
    expect(html).not.toContain('%SITE_ORIGIN%');
  });

  it('primes the built index.html, using the CDN root Vite wrote into it', async () => {
    await publish();
    const res = await SELF.fetch(`${ORIGIN}/s/new-name`);
    const html = await res.text();
    expect(html).toContain('<script type="module"');
    expect(html).toContain('<title>Old town · panote</title>');
    // The built page's site-wide tags are gone, the tour's own in their place.
    expect(html).not.toContain('Host 360° panorama tours');
    expect(html).not.toContain('https://panote.dev/og.jpg');
    expect(html.match(/name="description"/g)).toHaveLength(1);
    // Revalidated every time and with no validator, so no cache can reuse a primed page
    // (crawler or person) without asking the Worker again; no Vary needed.
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=0, must-revalidate');
    expect(res.headers.get('ETag')).toBeNull();
    expect(res.headers.get('Last-Modified')).toBeNull();
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

describe('the explore page', () => {
  it("swaps the landing's title and preview text for /explore's own, keeping the image", async () => {
    const res = await call('/explore');
    expect(res.status).toBe(200);
    expect(res.headers.get('ETag')).toBeNull();
    const html = await res.text();
    expect(html).toContain('<title>Explore 360° tours · panote</title>');
    expect(html).toContain('<meta name="description" content="Public 360° tours on panote');
    expect(html).toContain('<meta property="og:title" content="Explore 360° tours · panote" />');
    expect(html).toContain(`<meta property="og:url" content="${ORIGIN}/explore"></head>`);
    expect(html).toContain(`<meta property="og:image" content="${ORIGIN}/og.jpg" />`);
    expect(html.match(/<title>/g)).toHaveLength(1);
    expect(html.match(/name="description"/g)).toHaveLength(1);
  });

  it('leaves anything but /explore itself, and a non-HTML answer, alone', async () => {
    expect(await (await call('/explore/deeper')).text()).toBe(PAGE);
    const res = await call('/explore', undefined, {
      ASSETS: { fetch: async () => new Response('gone', { status: 404 }) } as unknown as Fetcher,
    });
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('gone');
  });

  it('tags it noindex off production, like the tour pages', async () => {
    const res = await call('/explore', undefined, { INDEXABLE: 'false' });
    expect(res.headers.get('X-Robots-Tag')).toBe('noindex, nofollow');
  });

  it('runs the script first for /explore, on the built index.html', async () => {
    const html = await (await SELF.fetch(`${ORIGIN}/explore`)).text();
    expect(html).toContain('<script type="module"');
    expect(html).toContain('<title>Explore 360° tours · panote</title>');
    expect(html).not.toContain('Host 360° panorama tours');
  });
});
