import { describe, expect, it, vi } from 'vitest';
import {
  buildProbes,
  evaluate,
  isAccessLoginRedirect,
  runProbe,
  type Expectation,
  type ProbeEnv,
} from './health-probes.js';

const html = (body = '<!doctype html><title>x</title>', status = 200) =>
  new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
const redirect = (location: string, status = 302) =>
  new Response(null, { status, headers: { location } });
const ACCESS_LOGIN = 'https://panote.cloudflareaccess.com/cdn-cgi/access/login/panote.dev?kid=x';

describe('isAccessLoginRedirect', () => {
  it.each([
    [redirect(ACCESS_LOGIN), true],
    [redirect(ACCESS_LOGIN, 303), true],
    [redirect('https://cloudflareaccess.com/'), true],
    [redirect('https://evilcloudflareaccess.com/login'), false],
    [redirect('https://panote.cloudflareaccess.com.evil.example/'), false],
    [redirect('/login'), false],
    [new Response(null, { status: 302 }), false],
    [new Response('x', { status: 200, headers: { location: ACCESS_LOGIN } }), false],
  ])('%#', (res, expected) => {
    expect(isAccessLoginRedirect(res)).toBe(expected);
  });
});

describe('evaluate', () => {
  const cases: [Expectation, () => Response, string | null][] = [
    ['page', () => html(), null],
    ['page', () => html('oops', 500), 'HTTP 500'],
    ['page', () => Response.json({}), 'HTTP 200 but not HTML'],
    ['page', () => redirect(ACCESS_LOGIN), 'HTTP 302'],
    ['page-or-access-login', () => redirect(ACCESS_LOGIN), null],
    ['page-or-access-login', () => html(), null],
    ['page-or-access-login', () => redirect('https://example.com/'), 'HTTP 302'],
    ['page-or-access-login', () => html('bad gateway', 502), 'HTTP 502'],
    ['tour-page', () => html('<script type="application/json" id="pn-boot">{}</script>'), null],
    ['tour-page', () => html('<div id="root"></div>'), "HTTP 200 without the tour's boot data"],
    ['tour-page', () => html('', 404), 'HTTP 404'],
    ['explore-json', () => Response.json({ tours: [], cursor: null }), null],
    ['explore-json', () => Response.json({ error: 'x' }), 'HTTP 200 without a tours list'],
    ['explore-json', () => html('<html>'), 'HTTP 200 without a tours list'],
    ['explore-json', () => Response.json({ error: 'x' }, { status: 429 }), 'HTTP 429'],
    ['unauthorized', () => Response.json({ error: 'unauthorized' }, { status: 401 }), null],
    ['unauthorized', () => Response.json({}, { status: 500 }), 'HTTP 500, expected 401'],
    ['unauthorized', () => Response.json({}, { status: 404 }), 'HTTP 404, expected 401'],
    ['unauthorized', () => Response.json({}), 'HTTP 200, expected 401'],
  ];
  it.each(cases)('%s %#', async (expect_, res, expected) => {
    expect(await evaluate(expect_, res())).toBe(expected);
  });
});

describe('runProbe', () => {
  it('passes a response that meets the expectation', async () => {
    expect(await runProbe({ name: 'p', expect: 'page', run: async () => html() })).toEqual({
      name: 'p',
      ok: true,
      detail: 'ok',
    });
  });

  it('fails with only the error name when the request throws', async () => {
    const result = await runProbe({
      name: 'p',
      expect: 'page',
      run: () => Promise.reject(new TypeError('connect to 10.0.0.1 refused')),
    });
    expect(result).toEqual({ name: 'p', ok: false, detail: 'TypeError' });
  });

  it('times out a probe that never answers, and aborts its request', async () => {
    let aborted = false;
    const result = await runProbe(
      {
        name: 'p',
        expect: 'page',
        run: (signal) =>
          new Promise<Response>(() => {
            signal.addEventListener('abort', () => {
              aborted = true;
            });
          }),
      },
      20,
    );
    expect(result).toEqual({ name: 'p', ok: false, detail: 'TimeoutError' });
    expect(aborted).toBe(true);
  });

  it('releases a body it did not read', async () => {
    const res = html('x', 503);
    const cancel = vi.spyOn(res.body!, 'cancel');
    await runProbe({ name: 'p', expect: 'page', run: async () => res });
    expect(cancel).toHaveBeenCalled();
  });
});

describe('buildProbes', () => {
  const recorder = () => {
    const requests: Request[] = [];
    const fetcher = {
      fetch: async (req: Request) => {
        requests.push(req);
        return html();
      },
    } as unknown as Fetcher;
    return { fetcher, requests };
  };
  const probeEnv = (overrides: Partial<ProbeEnv> = {}) => {
    const r = recorder();
    const env: ProbeEnv = {
      HEALTH_SITE_ORIGIN: 'https://panote.dev/',
      HEALTH_TOUR_SLUG: '',
      HEALTH_PUBLIC_PROBES: 'false',
      WEBSITE: r.fetcher,
      ADMIN_APP: r.fetcher,
      PUBLIC_API: r.fetcher,
      ADMIN_API: r.fetcher,
      UPLOAD_API: r.fetcher,
      ...overrides,
    };
    return { env, requests: r.requests };
  };

  it('probes each Worker through its service binding at the site origin', async () => {
    const { env, requests } = probeEnv();
    const probes = buildProbes(env);
    expect(probes.map((p) => [p.name, p.expect])).toEqual([
      ['website /', 'page'],
      ['website /explore', 'page'],
      ['admin app /app/', 'page'],
      ['public-api /api/explore', 'explore-json'],
      ['admin-api /api/admin/panos', 'unauthorized'],
      ['upload-api /api/upload-url', 'unauthorized'],
    ]);
    await Promise.all(probes.map((p) => p.run(new AbortController().signal)));
    expect(requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      'GET https://panote.dev/',
      'GET https://panote.dev/explore',
      'GET https://panote.dev/app/',
      'GET https://panote.dev/api/explore',
      'GET https://panote.dev/api/admin/panos',
      'POST https://panote.dev/api/upload-url',
    ]);
    // Never authenticated: the 401 is the point.
    expect(requests.every((r) => !r.headers.has('authorization'))).toBe(true);
  });

  it("probes the configured tour's page, and skips a slug that isn't valid", async () => {
    const { env, requests } = probeEnv({ HEALTH_TOUR_SLUG: 'my-tour' });
    const tour = buildProbes(env).find((p) => p.name === 'website tour page');
    expect(tour?.expect).toBe('tour-page');
    await tour?.run(new AbortController().signal);
    expect(requests.map((r) => r.url)).toEqual(['https://panote.dev/s/my-tour']);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const bad = buildProbes(probeEnv({ HEALTH_TOUR_SLUG: '../admin' }).env);
    expect(bad.some((p) => p.name === 'website tour page')).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('HEALTH_TOUR_SLUG'));
  });

  it('adds the public URL probes only when enabled, without following redirects', async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const publicFetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return redirect(ACCESS_LOGIN);
    }) as unknown as typeof fetch;
    expect(
      buildProbes(probeEnv().env, publicFetch).some((p) => p.name.startsWith('public URL')),
    ).toBe(false);
    const probes = buildProbes(probeEnv({ HEALTH_PUBLIC_PROBES: 'true' }).env, publicFetch);
    const pub = probes.filter((p) => p.name.startsWith('public URL'));
    expect(pub.map((p) => [p.name, p.expect])).toEqual([
      ['public URL /', 'page-or-access-login'],
      ['public URL /api/explore', 'explore-json'],
    ]);
    const results = await Promise.all(pub.map((p) => runProbe(p)));
    expect(calls.map((c) => [c.url, c.init?.redirect])).toEqual([
      ['https://panote.dev/', 'manual'],
      ['https://panote.dev/api/explore', 'manual'],
    ]);
    // On dev the page is behind Access, so its login redirect is up, but the API must
    // never be: an Access redirect there means the /api/* bypass is gone.
    expect(results.map((r) => r.ok)).toEqual([true, false]);
  });
});
