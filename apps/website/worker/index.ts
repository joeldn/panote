import { preloadLinks, preloadUrls, readTourBoot, scriptJson, type TourBoot } from './boot.js';
import { resolveSlug, type SlugResolution } from './redirect.js';

// Same value as NOINDEX in @internal/web-kit, kept local so the script bundles nothing else.
const NOINDEX = 'noindex, nofollow';

// _headers doesn't cover Worker-generated responses, so off production the script tags them itself.
function withRobots(response: Response, env: Env): Response {
  if (env.INDEXABLE === 'true') return response;
  const tagged = new Response(response.body, response);
  tagged.headers.set('X-Robots-Tag', NOINDEX);
  return tagged;
}

/** A CDN root as the Vite build writes it into index.html: an http(s) URL ending in `/`. */
const CDN_BASE = /^https?:\/\/[^\s"<>]+\/$/;

/**
 * Primes the SPA's HTML for one tour: the real title, the data the SPA would fetch
 * (`#pn-boot`, read once by TourPage), and preloads for the start scene's manifest and
 * level-0 tiles so they download alongside the JS. The CDN root comes from the
 * preconnect link the Vite build adds (`data-cdn-base`), so the Worker needs no var.
 */
function primeHtml(response: Response, boot: TourBoot): Response {
  const title = `${boot.tour.title} · panote`;
  const data = scriptJson({ slug: boot.slug, record: boot.record, tour: boot.tour });
  const unlisted = boot.tour.visibility === 'unlisted';
  const rewritten = new HTMLRewriter()
    .on('title', {
      element(el) {
        el.setInnerContent(title);
      },
    })
    .on('link[data-cdn-base]', {
      element(el) {
        const cdnBase = el.getAttribute('data-cdn-base') ?? '';
        if (!boot.manifest || !CDN_BASE.test(cdnBase)) return;
        el.after(preloadLinks(preloadUrls(`${cdnBase}tiles/`, boot.manifest)), { html: true });
      },
    })
    .on('head', {
      element(el) {
        if (unlisted) el.append('<meta name="robots" content="noindex">', { html: true });
        el.append(`<script type="application/json" id="pn-boot">${data}</script>`, {
          html: true,
        });
      },
    })
    .transform(response);
  const primed = new Response(rewritten.body, rewritten);
  // The body is now per-tour and per-request; the asset's ETag no longer describes it.
  primed.headers.delete('ETag');
  return primed;
}

const isHtml = (response: Response): boolean =>
  response.status === 200 && (response.headers.get('Content-Type') ?? '').includes('text/html');

/** The live tour page: index.html primed with R2 data, or plain on any failure. */
async function tourPage(
  request: Request,
  env: Env,
  live: Extract<SlugResolution, { kind: 'tour' }>,
): Promise<Response> {
  const url = new URL(request.url);
  // Never a 304: a primed page has no validator, and a cached plain one must not win.
  const headers = new Headers(request.headers);
  headers.delete('If-None-Match');
  headers.delete('If-Modified-Since');
  const [html, boot] = await Promise.all([
    env.ASSETS.fetch(new Request(request, { headers })),
    readTourBoot(env.BUCKET, live.path, live.record, url).catch((err: unknown) => {
      console.error('tour boot read failed', err);
      return null;
    }),
  ]);
  if (!boot || !isHtml(html)) return html;
  try {
    return primeHtml(html, boot);
  } catch (err) {
    console.error('tour page priming failed', err);
    return html;
  }
}

// Runs only for /s/* (assets.run_worker_first); every other path never reaches it.
export default {
  async fetch(request, env): Promise<Response> {
    if (request.method === 'GET' || request.method === 'HEAD') {
      let resolved: SlugResolution | null = null;
      try {
        resolved = await resolveSlug(new URL(request.url), env.BUCKET);
      } catch (err) {
        // An R2 hiccup must not take the viewer down: the SPA resolves the slug itself.
        console.error('slug lookup failed', err);
      }
      if (resolved?.kind === 'redirect') {
        const redirect = new Response(null, {
          status: 308,
          headers: { Location: resolved.location, 'Cache-Control': 'no-store' },
        });
        return withRobots(redirect, env);
      }
      if (resolved?.kind === 'tour' && request.method === 'GET') {
        return withRobots(await tourPage(request, env, resolved), env);
      }
    }
    return withRobots(await env.ASSETS.fetch(request), env);
  },
} satisfies ExportedHandler<Env>;
