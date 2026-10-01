import { env, SELF } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import worker from './index.js';
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

const assets = { fetch: vi.fn(async () => new Response('spa', { status: 200 })) };

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
    expect(await res.text()).toBe('spa');
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

describe('X-Robots-Tag', () => {
  beforeEach(async () => {
    await putSlug('old-name', alias('new-name'));
    await putSlug('new-name', live(TOUR));
  });

  it('tags the 308 and the passed-through SPA on dev (INDEXABLE=false)', async () => {
    expect(env.INDEXABLE).toBe('false');
    expect((await call('/s/old-name')).headers.get('X-Robots-Tag')).toBe('noindex, nofollow');
    const page = await call('/s/new-name');
    expect(await page.text()).toBe('spa');
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

  it('runs the script first for /s/*', async () => {
    await putSlug('old-name', alias('new-name'));
    await putSlug('new-name', live(TOUR));
    const res = await SELF.fetch(`${ORIGIN}/s/old-name?pano=p1`, { redirect: 'manual' });
    expect(res.status).toBe(308);
    expect(res.headers.get('Location')).toBe('/s/new-name?pano=p1');
  });
});
