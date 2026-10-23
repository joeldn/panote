import { isHeldBack, localizePublishedTour, pickLanguage } from '@internal/contracts';

import { isLinkPreviewBot } from './bots.js';
import { preloadLinks, preloadUrls, readTourBoot, scriptJson, type TourBoot } from './boot.js';
import { EXPLORE_PATH, explorePage } from './explore.js';
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
 * meta, link preview tags, preloads and boot data; without one, the page's own title and
 * site-wide preview tags, back as they were (the same as any page the script doesn't prime).
 */
function headTail(
  boot: TourBoot | null,
  plain: PlainHead,
  cdnBase: string,
  canonical: string,
  lang: string | null,
): string {
  if (!boot) {
    return (plain.title === null ? '' : `<title>${plain.title}</title>`) + plain.metas.join('');
  }
  // The SPA gets the bundle as stored and picks the language itself.
  const data = scriptJson({ slug: boot.slug, record: boot.record, tour: boot.tour });
  const tilesBase = CDN_BASE.test(cdnBase) ? `${cdnBase}tiles/` : null;
  const preloads =
    boot.manifest && tilesBase !== null ? preloadLinks(preloadUrls(tilesBase, boot.manifest)) : '';
  // Title and preview tags in the ?lang= language when the tour has it, else the default
  // (a scraper sends no useful Accept-Language, and the card should match the link).
  const shown = {
    ...boot,
    tour: localizePublishedTour(boot.tour, pickLanguage(boot.tour.languages, lang)),
  };
  return (
    `<title>${escapeText(`${shown.tour.title} · panote`)}</title>` +
    // Unlisted, or a new account's tour still held back (heldUntil): not for search engines.
    (boot.tour.visibility === 'unlisted' || isHeldBack(boot.tour, Date.now())
      ? '<meta name="robots" content="noindex">'
      : '') +
    linkPreviewTags(shown, canonical, tilesBase) +
    preloads +
    `<script type="application/json" id="pn-boot">${data}</script>`
  );
}

/** What the tour page lifts out of the static head, to write back if there is no tour. */
interface PlainHead {
  title: string | null;
  /** The site-wide description and preview tags, serialized as they came. */
  metas: string[];
}

// index.html carries the landing page's description and link preview tags. A tour page
// has its own, so the static ones must not reach it: a scraper reads the first og:title.
const SITE_META = [
  'head > meta[name="description"]',
  'head > meta[property^="og:"]',
  'head > meta[name^="twitter:"]',
];

// Attribute values come back as written in the source (entities still encoded), and
// index.html quotes them with `"`, so only a stray `"` needs escaping on the way back out.
const serializeMeta = (el: Element): string => {
  const attrs = [...el.attributes].map(
    ([name, value = '']) => `${name}="${value.replace(/"/g, '&quot;')}"`,
  );
  return `<meta ${attrs.join(' ')}>`;
};

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
 * The site-wide description and preview tags (SITE_META) are lifted out the same way: the
 * tour's own replace them, or they go back as they were.
 * The insertion is a stream from a sync end-tag handler: an async handler would hold back
 * the bytes before it until it resolved, and HTMLRewriter flushes them for a stream.
 * `#pn-boot` lands inside `<head>`, and a module script runs only after the whole document
 * has parsed, so the app always finds it.
 */
function primeHtml(
  response: Response,
  boot: Promise<TourBoot | null>,
  canonical: string,
  lang: string | null,
): Response {
  const plain: PlainHead = { title: null, metas: [] };
  let cdnBase = '';
  let rewriter = new HTMLRewriter().on('head > title', {
    element(el) {
      plain.title ??= '';
      el.remove();
    },
    text(chunk) {
      plain.title = (plain.title ?? '') + chunk.text;
    },
  });
  for (const selector of SITE_META) {
    rewriter = rewriter.on(selector, {
      element(el) {
        plain.metas.push(serializeMeta(el));
        el.remove();
      },
    });
  }
  const rewritten = rewriter
    .on('link[data-cdn-base]', {
      element(el) {
        cdnBase = el.getAttribute('data-cdn-base') ?? '';
      },
    })
    .on('head', {
      element(el) {
        el.onEndTag((end) => {
          // Everything the tail needs from the head has been seen by now.
          const head = { title: plain.title, metas: [...plain.metas] };
          const base = cdnBase;
          const tail = boot
            .then((b) => headTail(b, head, base, canonical, lang))
            .catch((err: unknown) => {
              console.error('tour page priming failed', err);
              return headTail(null, head, base, canonical, lang);
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
 * How long the R2 reads may hold the end of the head back for a person. Past this the page
 * finishes plain and the SPA fetches the tour itself. The head streams before the reads, so
 * a slow R2 delays the boot data and the rest of the page by at most this much, not the
 * app's JS.
 */
export const BOOT_BUDGET_MS = 300;

/**
 * The same, for a link-preview or search crawler (bots.ts). A crawler runs no JS, so a
 * plain page is a card with no tour title, description or image, and it waits for the whole
 * document anyway. R2 answers in tens of milliseconds, so a read still pending after 5 s is
 * an incident, not latency: waiting longer only risks the crawler's own fetch timeout
 * (a few seconds on the stricter unfurlers) and getting no card at all, where the plain page
 * still gives a generic one.
 */
export const BOT_BOOT_BUDGET_MS = 5000;

function withinBudget<T>(read: Promise<T | null>, budgetMs: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      console.warn(`tour boot read took over ${budgetMs}ms; serving the plain page`);
      resolve(null);
    }, budgetMs);
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
  // Started before the HTML is awaited: the reads run while the head streams. Only the wait
  // depends on the User-Agent, never the content: a crawler gets the same primed page a
  // person gets when R2 is quick, so a cache holding either can't serve the wrong shape.
  const budget = isLinkPreviewBot(request.headers.get('User-Agent'))
    ? BOT_BOOT_BUDGET_MS
    : BOOT_BUDGET_MS;
  const boot = withinBudget(
    readTourBoot(env.BUCKET, live.path, live.record, new URL(request.url)).catch((err: unknown) => {
      console.error('tour boot read failed', err);
      return null;
    }),
    budget,
  );
  const html = await page;
  if (!isHtml(html)) return html;
  // Covers the synchronous rewriter setup only. Once streaming, a failure while building
  // the head's tail falls back to the plain title inside primeHtml.
  try {
    // og:url: the tour's own page, never the embed or a query variant.
    const url = new URL(request.url);
    const canonical = `${url.origin}/s/${live.path.slug}`;
    return primeHtml(html, boot, canonical, url.searchParams.get('lang'));
  } catch (err) {
    console.error('tour page priming failed', err);
    return html;
  }
}

// Runs only for /s/* and /explore (assets.run_worker_first); every other path never reaches it.
export default {
  async fetch(request, env): Promise<Response> {
    if (request.method === 'GET' || request.method === 'HEAD') {
      const url = new URL(request.url);
      if (url.pathname === EXPLORE_PATH) {
        const page = await env.ASSETS.fetch(request);
        return withRobots(isHtml(page) ? explorePage(page, url.origin) : page, env);
      }
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
