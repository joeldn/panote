import { SLUG_PATTERN } from '@internal/contracts';

// The health check's probes of the public surface (docs/deploy.md, "Monitoring and
// alerts"). Most go through service bindings, straight into each Worker: that proves the
// Worker's code runs and answers, needs no route, and never meets the Cloudflare Access
// gate that keeps panote.dev's pages private. Two more go through the public URL, the
// way a visitor would, to catch a broken route or Access setup; there an Access login
// redirect counts as up, since on dev that is what a visitor without a session gets.

/** What a probe's response must look like to count as up. */
export type Expectation =
  // 200 with an HTML body.
  | 'page'
  // 200 HTML carrying the tour's boot data: the slug resolved and the bundle was read.
  | 'tour-page'
  // 200 JSON with a tours array, as GET /api/explore answers.
  | 'explore-json'
  // 401: the Worker ran and refused an unauthenticated call (and didn't 5xx).
  | 'unauthorized'
  // A 'page', or a redirect to the Cloudflare Access login (dev).
  | 'page-or-access-login';

export interface Probe {
  /** Stable name: the key in the health state, and what the alert email lists. */
  name: string;
  expect: Expectation;
  run: (signal: AbortSignal) => Promise<Response>;
}

export interface CheckResult {
  name: string;
  ok: boolean;
  /** Why it failed (status, content type, error name), or a short note when it passed. */
  detail: string;
}

export interface ProbeEnv {
  HEALTH_SITE_ORIGIN: string;
  HEALTH_TOUR_SLUG?: string;
  HEALTH_PUBLIC_PROBES?: string;
  WEBSITE: Fetcher;
  ADMIN_APP: Fetcher;
  PUBLIC_API: Fetcher;
  ADMIN_API: Fetcher;
  UPLOAD_API: Fetcher;
}

export const PROBE_TIMEOUT_MS = 10_000;

const USER_AGENT = 'panote-health-check';

const ACCESS_LOGIN_HOST = /(^|\.)cloudflareaccess\.com$/;

/** A 3xx to a Cloudflare Access team domain: the page is gated, not down. */
export const isAccessLoginRedirect = (res: Response): boolean => {
  if (res.status < 300 || res.status > 399) return false;
  const location = res.headers.get('location');
  if (!location) return false;
  try {
    return ACCESS_LOGIN_HOST.test(new URL(location).hostname);
  } catch {
    return false;
  }
};

const isHtml = (res: Response): boolean =>
  (res.headers.get('content-type') ?? '').toLowerCase().includes('text/html');

const errorName = (e: unknown): string => (e instanceof Error ? e.name : 'unknown error');

/** null when the response is what `expect` asks for, else why not. Consumes the body. */
export const evaluate = async (expect: Expectation, res: Response): Promise<string | null> => {
  const status = `HTTP ${res.status}`;
  switch (expect) {
    case 'unauthorized':
      return res.status === 401 ? null : `${status}, expected 401`;
    case 'page-or-access-login':
      if (isAccessLoginRedirect(res)) return null;
      return evaluate('page', res);
    case 'page':
      if (res.status !== 200) return status;
      return isHtml(res) ? null : `${status} but not HTML`;
    case 'tour-page': {
      if (res.status !== 200) return status;
      if (!isHtml(res)) return `${status} but not HTML`;
      const body = await res.text();
      return body.includes('id="pn-boot"') ? null : `${status} without the tour's boot data`;
    }
    case 'explore-json': {
      if (res.status !== 200) return status;
      const body: unknown = await res.json().catch(() => null);
      const tours = (body as { tours?: unknown } | null)?.tours;
      return Array.isArray(tours) ? null : `${status} without a tours list`;
    }
  }
};

/** Runs one probe with a timeout. Never throws. */
export const runProbe = async (
  probe: Probe,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<CheckResult> => {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const e = new Error(`no answer in ${timeoutMs} ms`);
      e.name = 'TimeoutError';
      controller.abort(e);
      reject(e);
    }, timeoutMs);
  });
  try {
    const failure = await Promise.race([
      (async () => {
        const res = await probe.run(controller.signal);
        try {
          return await evaluate(probe.expect, res);
        } finally {
          // evaluate may not have read it; an unread body holds the connection.
          if (!res.bodyUsed) await res.body?.cancel().catch(() => undefined);
        }
      })(),
      timeout,
    ]);
    return failure === null
      ? { name: probe.name, ok: true, detail: 'ok' }
      : { name: probe.name, ok: false, detail: failure };
  } catch (e) {
    return { name: probe.name, ok: false, detail: errorName(e) };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

/** The probes for this environment, in a fixed order. */
export const buildProbes = (env: ProbeEnv, publicFetch: typeof fetch = fetch): Probe[] => {
  const origin = env.HEALTH_SITE_ORIGIN.replace(/\/+$/, '');
  const via =
    (binding: Fetcher, path: string, method = 'GET') =>
    (signal: AbortSignal) =>
      binding.fetch(
        new Request(`${origin}${path}`, { method, signal, headers: { 'user-agent': USER_AGENT } }),
      );
  const probes: Probe[] = [
    { name: 'website /', expect: 'page', run: via(env.WEBSITE, '/') },
    { name: 'website /explore', expect: 'page', run: via(env.WEBSITE, '/explore') },
  ];
  const slug = env.HEALTH_TOUR_SLUG?.trim() ?? '';
  if (SLUG_PATTERN.test(slug)) {
    probes.push({
      name: 'website tour page',
      expect: 'tour-page',
      run: via(env.WEBSITE, `/s/${slug}`),
    });
  } else if (slug) {
    console.warn('[health] HEALTH_TOUR_SLUG is not a valid slug, tour page not probed');
  }
  probes.push(
    { name: 'admin app /app/', expect: 'page', run: via(env.ADMIN_APP, '/app/') },
    {
      name: 'public-api /api/explore',
      expect: 'explore-json',
      run: via(env.PUBLIC_API, '/api/explore'),
    },
    {
      name: 'admin-api /api/admin/panos',
      expect: 'unauthorized',
      run: via(env.ADMIN_API, '/api/admin/panos'),
    },
    {
      name: 'upload-api /api/upload-url',
      expect: 'unauthorized',
      run: via(env.UPLOAD_API, '/api/upload-url', 'POST'),
    },
  );
  if (env.HEALTH_PUBLIC_PROBES === 'true') {
    const viaPublic = (path: string) => (signal: AbortSignal) =>
      publicFetch(`${origin}${path}`, {
        signal,
        redirect: 'manual',
        headers: { 'user-agent': USER_AGENT },
      });
    probes.push(
      { name: 'public URL /', expect: 'page-or-access-login', run: viaPublic('/') },
      { name: 'public URL /api/explore', expect: 'explore-json', run: viaPublic('/api/explore') },
    );
  }
  return probes;
};
