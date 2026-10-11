import { preloadLinks, preloadUrls, readTourBoot, scriptJson, type TourBoot } from './boot.js';
import { linkPreviewTags } from './og.js';
import { parseSlugPath, resolveSlug, type SlugResolution } from './redirect.js';

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

const escapeText = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * What goes at the end of the head once the R2 reads settle: for a tour, its title, robots
 * meta, link preview tags, preloads and boot data; without one, just the page's own title,
 * back as it was (no preview tags, the same as any page the script doesn't prime).
 */
function headTail(
  boot: TourBoot | null,
  plainTitle: string | null,
  cdnBase: string,
  canonical: string,
): string {
  if (!boot) return plainTitle === null ? '' : `<title>${plainTitle}</title>`;
  const data = scriptJson({ slug: boot.slug, record: boot.record, tour: boot.tour });
  const tilesBase = CDN_BASE.test(cdnBase) ? `${cdnBase}tiles/` : null;
  const preloads =
    boot.manifest && tilesBase !== null ? preloadLinks(preloadUrls(tilesBase, boot.manifest)) : '';
  return (
    `<title>${escapeText(`${boot.tour.title} · panote`)}</title>` +
    (boot.tour.visibility === 'unlisted' ? '<meta name="robots" content="noindex">' : '') +
    linkPreviewTags(boot, canonical, tilesBase) +
    preloads +
    `<script type="application/json" id="pn-boot">${data}</script>`
  );
}

/** A stream of one string, produced once `html` settles. It never errors. */
function htmlStream(html: Promise<string>): ReadableStream<Uint8Array> {
  return new ReadableStream({
    async start(controller) {
      controller.enqueue(new TextEncoder().encode(await html));
      controller.close();
    },
  });
}

/**
 * Primes the SPA's HTML for one tour, streaming: everything up to `</head>` (the app's
 * module script, stylesheet and CDN preconnect) goes out at once, and the rest waits for
 * the R2 reads. At `</head>` it inserts the real title, link preview tags (og:, twitter:,
 * see og.ts), the data the SPA would fetch (`#pn-boot`, which TourPage hands to
 * loadPublishedTour on its first attempt, used only for the same slug and after the same
 * schema checks; a retry always fetches), and
 * preloads for the start scene's manifest and level-0 tiles so they download alongside
 * the JS. The CDN root comes from the preconnect link the Vite build adds
 * (`data-cdn-base`), so the Worker needs no var.
 *
 * The page's own `<title>` sits above the module script, so it is lifted out and written
 * back at `</head>` (the tour's title, or the original when there is nothing to inline).
 * The insertion is a stream from a sync end-tag handler: an async handler would hold back
 * the bytes before it until it resolved, and HTMLRewriter flushes them for a stream.
 * `#pn-boot` lands inside `<head>`, and a module script runs only after the whole document
 * has parsed, so the app always finds it.
 */
function primeHtml(
  response: Response,
  boot: Promise<TourBoot | null>,
  canonical: string,
): Response {
  let plainTitle: string | null = null;
  let cdnBase = '';
  const rewritten = new HTMLRewriter()
    .on('head > title', {
      element(el) {
        plainTitle ??= '';
        el.remove();
      },
      text(chunk) {
        plainTitle = (plainTitle ?? '') + chunk.text;
      },
    })
    .on('link[data-cdn-base]', {
      element(el) {
        cdnBase = el.getAttribute('data-cdn-base') ?? '';
      },
    })
    .on('head', {
      element(el) {
        el.onEndTag((end) => {
          // Everything the tail needs from the head has been seen by now.
          const [title, base] = [plainTitle, cdnBase];
          const tail = boot
            .then((b) => headTail(b, title, base, canonical))
            .catch((err: unknown) => {
              console.error('tour page priming failed', err);
              return headTail(null, title, base, canonical);
            });
          end.before(htmlStream(tail), { html: true });
        });
      },
    })
    .transform(response);
  const primed = new Response(rewritten.body, rewritten);
  // The body is now per-tour and per-request; the asset's ETag no longer describes it.
  primed.headers.delete('ETag');
  return primed;
}

/**
 * How long the R2 reads may hold the end of the head back. Past this the page finishes
 * plain and the SPA fetches the tour itself. The head streams before the reads, so a slow
 * R2 delays the boot data and the rest of the page by at most this much, not the app's JS.
 */
export const BOOT_BUDGET_MS = 300;

function withinBudget<T>(read: Promise<T | null>): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      console.warn(`tour boot read took over ${BOOT_BUDGET_MS}ms; serving the plain page`);
      resolve(null);
    }, BOOT_BUDGET_MS);
  });
  return Promise.race([read, timeout]).finally(() => {
    if (timer !== null) clearTimeout(timer);
  });
}

const isHtml = (response: Response): boolean =>
  response.status === 200 && (response.headers.get('Content-Type') ?? '').includes('text/html');

/**
 * index.html for a slug path. Never a 304: a primed page has no validator, and a cached
 * plain one must not win. It is fetched before the slug is known to be a live tour, so a
 * slug that falls through to the SPA gets a full 200 as well.
 */
function fetchPage(request: Request, env: Env): Promise<Response> {
  const headers = new Headers(request.headers);
  headers.delete('If-None-Match');
  headers.delete('If-Modified-Since');
  return env.ASSETS.fetch(new Request(request, { headers }));
}

/** The live tour page: index.html primed with R2 data, or plain on any failure. */
async function tourPage(
  request: Request,
  env: Env,
  live: Extract<SlugResolution, { kind: 'tour' }>,
  page: Promise<Response>,
): Promise<Response> {
  // Started before the HTML is awaited: the reads run while the head streams.
  const boot = withinBudget(
    readTourBoot(env.BUCKET, live.path, live.record, new URL(request.url)).catch((err: unknown) => {
      console.error('tour boot read failed', err);
      return null;
    }),
  );
  const html = await page;
  if (!isHtml(html)) return html;
  // Covers the synchronous rewriter setup only. Once streaming, a failure while building
  // the head's tail falls back to the plain title inside primeHtml.
  try {
    // og:url: the tour's own page, never the embed or a query variant.
    const canonical = `${new URL(request.url).origin}/s/${live.path.slug}`;
    return primeHtml(html, boot, canonical);
  } catch (err) {
    console.error('tour page priming failed', err);
    return html;
  }
}

// Runs only for /s/* (assets.run_worker_first); every other path never reaches it.
export default {
  async fetch(request, env): Promise<Response> {
    if (request.method === 'GET' || request.method === 'HEAD') {
      const url = new URL(request.url);
      // A GET for a slug path fetches its HTML while the slug is read, so a live tour can
      // start streaming the moment the slug resolves.
      const page =
        request.method === 'GET' && parseSlugPath(url.pathname) ? fetchPage(request, env) : null;
      // Nothing awaits the page until the slug read below settles, so a fetch that fails
      // first would be an unhandled rejection. Mark it handled; every path below that uses
      // the page still awaits it and gets the error.
      page?.catch(() => {});
      let resolved: SlugResolution | null = null;
      try {
        resolved = await resolveSlug(url, env.BUCKET);
      } catch (err) {
        // An R2 hiccup must not take the viewer down: the SPA resolves the slug itself.
        console.error('slug lookup failed', err);
      }
      if (resolved?.kind === 'redirect') {
        page?.then((res) => res.body?.cancel()).catch(() => {});
        const redirect = new Response(null, {
          status: 308,
          headers: { Location: resolved.location, 'Cache-Control': 'no-store' },
        });
        return withRobots(redirect, env);
      }
      if (page && resolved?.kind === 'tour') {
        return withRobots(await tourPage(request, env, resolved, page), env);
      }
      if (page) return withRobots(await page, env);
    }
    return withRobots(await env.ASSETS.fetch(request), env);
  },
} satisfies ExportedHandler<Env>;
