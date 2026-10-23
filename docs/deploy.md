# Deploy

How panote's four API/queue Workers and two frontend Workers get provisioned and deployed, and what state that provisioning is
actually in today. One Cloudflare account (`12e2809e05de8a2bf20b815fd394ec9a`), two Wrangler
named environments (`dev` → `panote.dev`, `production` → `panote.io`) per Worker's
`wrangler.jsonc`. See `docs/decisions.md` for why things are shaped this way; this doc is the
"how to actually run it" companion.

Resource names (R2 bucket, queues) deliberately keep the `pano-*` prefix inherited from
pano-viewer — the dev bucket and queues are the *same* Cloudflare resources pano-viewer's
Workers already use, cut over rather than recreated. Worker script names are `panote-*`.
pano-viewer itself was retired on 2026-09-26: its dev Workers (`pano-upload-dev`,
`pano-crud-dev`, `pano-tiler-dev`) and an orphaned container (`pano-tiler-dev-tiler-dev`) were
deleted, and the `joeldn/pano-viewer` GitHub repo was archived (not deleted). The bucket, queue,
and DLQ above are the only pieces of it still alive, and they belong to panote now.

---

## What deploys where

| Service | Script (dev / production) | Route (dev / production) | Bindings | Secrets |
|---|---|---|---|---|
| `services/public-api` | `panote-public-api-dev` / `panote-public-api` | `panote.dev/api/tours/*` + `panote.dev/api/errors` + `panote.dev/api/explore` / same on `panote.io` | `STATS` — Durable Object, class `TourStats`; `EVENTS` — Analytics Engine, dataset `panote_events_dev` / `panote_events` (unit B5); `BUCKET` — R2, `pano-content-dev` / `pano-content`, read-only by convention (likes check `pub/`, Explore reads `explore/`); rate limiters, see Abuse controls | `LIKER_HASH_KEY` (see Likes; without it production refuses likes) |
| `services/admin-api` | `panote-admin-api-dev` / `panote-admin-api` | `panote.dev/api/admin/*` / `panote.io/api/admin/*` | `BUCKET` — R2, bucket `pano-content-dev` / `pano-content`; `PUBLISHER` — Durable Object, class `TourPublisher` (one per tourId, serializes publish/slug/visibility/unpublish; migration `v1` `new_sqlite_classes`, applied by `wrangler deploy`); var `SLUG_ALIAS_DAYS` (`30`, days an old share-link slug keeps redirecting after a rename); var `NEW_ACCOUNT_HOLD_DAYS` (`7`, days a new account's public tours stay off Explore and `noindex`, see Explore; `"0"` turns it off); `STATS` — cross-script Durable Object binding to `public-api`'s `TourStats` (`script_name` `panote-public-api-dev` / `panote-public-api`; account delete clears a tour's counts, see Account deletion); daily Cron Trigger `17 3 * * *` that deletes expired slug aliases under `slugs/` and expired slug holds under `slug-holds/`, sweeps accounts marked for deletion, empties `trash/` of originals deleted 30 days ago, and deletes plan images nobody saved (`pub/plans/`), recording each run at `ops/cron/admin-api-daily.json` and each failed CDN purge at `ops/cdn-purge/last-failure.json` for the health check (Monitoring and alerts), queueing what still failed under `ops/cdn-purge/pending/` for the 15-minute cron to retry (CDN purge on delete); `PANO_DELETE_LIMITER` and `WRITE_LIMITER` rate limits (Rate limits); vars `CF_ACCOUNT_ID`, `AE_DATASET` (unit B5), `OPERATOR_SUB_SHA256` (who may open the operator pages, see Operator pages), `REQUIRE_RECENT_AUTH` (`true`; account delete wants a recent sign-in, see Account deletion) | `CF_ANALYTICS_TOKEN` (unit B5, insights; R2 itself uses the native binding, not the S3 API) |
| `services/upload-api` | `panote-upload-api-dev` / `panote-upload-api` | `panote.dev/api/upload-url` / `panote.io/api/upload-url` | `UPLOAD_CEILING` — Durable Object, class `UploadCeiling` (one instance, the global daily upload ceiling, see Owner quotas; migration `v1` `new_sqlite_classes`, applied by `wrangler deploy`); otherwise none (S3 API via `R2_ACCOUNT_ID`/`R2_BUCKET` vars) | `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` |
| `services/tiler-consumer` | `panote-tiler-consumer-dev` / `panote-tiler-consumer` | none — queue consumer and Cron Trigger, no `fetch` handler | `TILER` — container Durable Object, class `Tiler`; `BUCKET` — R2, bucket `pano-content-dev` / `pano-content` (unit B4: tile-failed marker); queue consumer on `pano-uploads-dev` / `pano-uploads` (`max_batch_size: 1`, `max_retries: 3`, `retry_delay: 60`, dlq `pano-uploads-dlq-dev` / `pano-uploads-dlq`, `max_concurrency: 5`) and, as of unit B4, on the DLQ itself (`max_batch_size: 10`, `max_retries: 3`, `max_concurrency: 1`, no further DLQ — see below); `ALERT_EMAIL` — `send_email`, unrestricted, var `ALERT_EMAIL_FROM` = `tiler-alerts@panote.io` (DLQ and health alert email, see below); Cron Trigger `*/5 * * * *` (health check, and DLQ alerts the throttle held back) with service bindings `WEBSITE`, `ADMIN_APP`, `PUBLIC_API`, `ADMIN_API`, `UPLOAD_API` to the other five Workers of the same env and vars `HEALTH_SITE_ORIGIN`, `HEALTH_TOUR_SLUG`, `HEALTH_PUBLIC_PROBES` (Monitoring and alerts) | `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` (forwarded into the container's `process.env` via `Container.envVars` — see `services/tiler-consumer/src/container-env.ts`); `ALERT_EMAIL_TO` (DLQ and health alert recipient, optional — unset means no email) |

All four: `observability.enabled: true` in both env blocks. `workers_dev` and `preview_urls`
are `false` in both `dev` and `production`: from the first dev deploy
after 2026-10-08 the dev Workers are only reachable through their `panote.dev` routes (see
Cloudflare Access below). `dev`'s `OAUTH_ISSUER` now points at the real Auth0 tenant,
`https://panote-dev.au.auth0.com/` (`OAUTH_AUDIENCE` `https://api.panote.dev`), provisioned
2026-09-25; `production`'s still ships the literal placeholder
`https://YOUR_PROD_TENANT.auth0.com/` until its own tenant exists — `isIssuerConfigured` in
`packages/worker-kit/src/auth.ts` rejects an unconfigured or placeholder-shaped issuer before any
network call, logging one `console.error` and returning 401. That guard runs inside
`authenticate()` on every request, but only *after* the bearer-token check: a request with no
`Authorization` header at all 401s first, before `isIssuerConfigured` ever runs, so it produces no
log line. Only a request that supplies some bearer token — even a bogus one — reaches the issuer
guard and produces the `console.error`, which now only fires for `production` (and for `dev` if
its config ever regresses to a placeholder). See the smoke test step below for what `dev` does
instead, and `docs/decisions.md` for why the placeholder must only ever be replaced by a real
tenant URL, never renamed to another fake one.

`admin-api` and `upload-api` require a bearer token on every route (`authenticate`);
`public-api` verifies it when present but never requires it (`authenticateOptional`) — its only
bimodal route is `POST /api/tours/:tourId/like` (falls back to an `X-Client-Id` header when
anonymous).

---

## Frontends

`apps/website` and `apps/admin` are Vite + React SPAs, each deployed as a Worker with **static
assets** on the same host as the APIs. Admin is assets-only; the website also has a small `main`
script that only runs for `/s/*` (slug redirects and tour page priming, below) and `/explore` (its
title and preview tags, see Explore). Why not Pages, and why
build-time config: `docs/decisions.md`.

| App | Script (dev / production) | Route (dev / production) | Vite `base` / output |
|---|---|---|---|
| `apps/website` | `panote-website-dev` / `panote-website` | `panote.dev/*` / `panote.io/*` | `/` → `dist/` |
| `apps/admin` | `panote-admin-dev` / `panote-admin` | `panote.dev/app` + `panote.dev/app/*` / same on `panote.io` | `/app/` → `dist/app/` |

Both: `assets.not_found_handling: "single-page-application"`, `observability.enabled: true` in
both env blocks, `workers_dev` and `preview_urls` `false` in both, no secrets. Admin has no
bindings; the website has `BUCKET` (R2, `pano-content-dev` / `pano-content`) and `ASSETS`.

**Route precedence.** The website's `panote.dev/*` overlaps every other route on the host.
Cloudflare resolves that by specificity: "When more than one route pattern could match a request
URL, the most specific route pattern wins" (Workers docs, [Routes → Matching
behavior](https://developers.cloudflare.com/workers/configuration/routing/routes/#matching-behavior),
with the example that `example.com/hello/*` takes precedence over `example.com/*`). So
`/api/admin/*`, `/api/tours/*`, `/api/errors`, `/api/explore` and `/api/upload-url` stay on the API Workers and `/app`, `/app/*`
on admin; everything else lands on the website. The docs' known issue about trailing `/*`
specificity (`/images/*` vs `/images*` on the same zone,
[Known issues](https://developers.cloudflare.com/workers/platform/known-issues/)) doesn't apply:
no two routes here differ only by that slash. Admin uses `/app` + `/app/*` rather than the plan's
`/app*`, which would also take `/apple`, `/application`, … from the website. Unmatched `/api/...`
paths now reach the website and get `index.html` with a 200 (accepted for v1; unit W3 adds a
404).

**Website slug redirects (`/s/*`).** `apps/website/wrangler.jsonc` sets `main: worker/index.ts`
and `assets.run_worker_first: ["/s/*"]` ([Static Assets binding →
`run_worker_first`](https://developers.cloudflare.com/workers/static-assets/binding/#run_worker_first):
an array of route patterns, `*` deep-matches, `!` negates). Every other path is served by the
assets router and never invokes the script. For `/s/<slug>` and `/s/<slug>/embed[/]` the script
reads `slugs/<slug>.json` through the `BUCKET` binding (it only reads `slugs/`, `pub/tours/` and
tile manifests; R2 bindings can't be scoped, so read-only is by convention). An unexpired `redirect` alias whose
target slug is still a live pointer to the **same** tourId gets a `308` to `/s/<new>` (or
`/s/<new>/embed`) with the query string kept and `Cache-Control: no-store`. Anything else (live
pointer, miss, expired alias, a target another tour holds, an invalid slug, an R2 error) falls
through to `env.ASSETS.fetch`, i.e. the SPA, which then shows the tour or its "This tour isn't
available" placeholder. `_headers` still applies to responses served through `env.ASSETS.fetch`
(checked under `wrangler dev`: CSP, `frame-ancestors` per path, nosniff). `wrangler types --env
dev` omits the inherited `ASSETS` binding, so `worker/assets.d.ts` declares it.
The `Location` is relative (`/s/<new-slug>`, query kept).

**Tour page priming (`/s/*`, GET only).** The script fetches `index.html` while it reads the
slug. For a live pointer it then reads `pub/tours/<tourId>.json` and the start scene's
`tiles/<panoId>/manifest.json` (alongside the tour when `?pano=` names the scene), and streams
the page through `HTMLRewriter`: the head up to `</head>` (module script, stylesheet, CDN
preconnect) goes out at once, and at `</head>` it inserts, once the reads settle, the real `<title>`
(`<tour> · panote`), `<meta name="robots" content="noindex">` for an unlisted tour or one whose
bundle's `heldUntil` is still ahead (a new account's, see Explore), a
`<script type="application/json" id="pn-boot">` holding `{slug, record, tour}` (with `<`
escaped), and `<link rel="preload" as="fetch" crossorigin>` for the manifest and the six level-0
tiles. The start scene follows `TourView` (a valid `?pano=` wins; an embed pinned to an unknown
scene gets no preloads). The tile URLs come from core's `tilePath` and the CDN root from the
`data-cdn-base` attribute the Vite build puts on its CDN preconnect link (`VITE_CDN_BASE`), so the
script has no CDN var. `crossorigin` matters: it matches the viewer's CORS `fetch()`, so the
browser reuses the preload. The SPA's `TourPage` passes `#pn-boot` to `loadPublishedTour` on its
first attempt, which uses it only if it is for the same slug and passes the same schemas.
The R2 reads get 300 ms (`BOOT_BUDGET_MS`); past that the script logs a warning and finishes
the plain page, so a slow R2 holds back the rest of the page by at most that much, never the
app's JS. Link-preview and search crawlers get 5 s instead (`BOT_BOOT_BUDGET_MS`, picked by
User-Agent from the list in `apps/website/worker/bots.ts`: facebookexternalhit, Twitterbot,
LinkedInBot, Slackbot, Discordbot, WhatsApp, TelegramBot, SkypeUriPreview (Teams), Applebot,
Pinterest, redditbot, Embedly, Iframely, Mastodon and other fediverse servers, Bluesky's Cardyb,
Googlebot, bingbot and a few more). A crawler runs no JS, so a plain page is a card without the
tour's title, description or image. R2 normally answers in tens of milliseconds, so 5 s only
matters during an incident, and it stays well inside the unfurlers' own fetch timeouts: past it a
crawler still gets the plain page rather than no card. Only the wait depends on the User-Agent,
never the content, so there is no `Vary: User-Agent`: a crawler gets the page a person gets when
R2 is quick. Nothing caches these pages anyway: the script uses no Cache API, the zone's cache
rules only cover `cdn.panote.dev`, and the HTML keeps `public, max-age=0, must-revalidate` with no
validator. A client that sends no browser UA (Signal builds its preview in the app) gets the
person budget. A streamed response has no `ETag`. A GET for a slug path is never a `304`: the
script drops `If-None-Match` and `If-Modified-Since` before it fetches `index.html`, so a cached
plain page can't stand in for a primed one. A HEAD keeps them and goes straight to
`env.ASSETS.fetch`, so a conditional HEAD can still get the asset's `304`. A missing or
invalid bundle, an R2 error on the tour read or the budget running out finish the page plain
(the original `<title>` moves to the end of the head, nothing else changes). HEAD, a non-HTML
asset response and a failed slug read serve `index.html` untouched. Either way the SPA fetches
as before.
That is two extra R2 reads per tour page view; the browser makes three fewer CDN reads.
Post-deploy checks (dev; production the same on `panote.io`):
- `curl -sI https://panote.dev/s/<old-slug>` on a renamed tour: `308`,
  `Location: /s/<new-slug>`, `Cache-Control: no-store`.
- `curl -sI https://panote.dev/s/<live-slug>`: `200` with `frame-ancestors 'none'` in the CSP.
- `curl -sI https://panote.dev/s/<live-slug>/embed` (and `/embed/`): `200` with `frame-ancestors *`.
  These two confirm `_headers` still applies to responses that pass through the script.
- `curl -s https://panote.dev/s/<live-slug> | grep -c 'rel="preload"'`: `7`, plus the tour's
  title in `<title>` and a `pn-boot` script. (panote.dev is behind Access, so pass the Access
  cookie or check from a signed-in browser's view-source.)

**Link previews (`/s/*`).** The same tail carries Open Graph and Twitter card tags, built in
`apps/website/worker/og.ts`: `<meta name="description">`, `og:type` `website`, `og:site_name`
`panote`, `og:title` (the tour title), `og:description`, `og:url` (`<origin>/s/<slug>`, no query
and no `/embed`), and `twitter:card`. The description is the tour's published `description`
(edited in the admin's tour settings, up to 300 characters, collapsed onto one line), else the
generated `A 360° virtual tour · N scenes`; control characters (C0, DEL, U+0085) become spaces,
since a hand-written bundle goes through a looser schema than the admin API. The image is the
start scene's own: the tiler's `og.jpg` (1200×630, `image/jpeg`) when the manifest has `og: true`
(see "Link-preview image" below), else its `preview.webp` (1024×512 equirect, `image/webp`) when
it has `preview: true`, with card `summary_large_image` and `og:image:alt` set to the scene title.
There is no cube-face fallback: face tiles are stored mirrored left to right (`faceUVToDir` in
`@panote/core`) and a scraper can't flip them back. No og.jpg or preview, no manifest, or a CDN
root that isn't absolute `https://` means no image and a `summary` card. Public and unlisted tours both get the tags: sharing the link is the point of
unlisted, and its `noindex` stays. `index.html` carries site-wide tags for the landing page (a
description, `og:*` with the static `/og.jpg` card, `twitter:card`); the script lifts those out of
the head as it streams (like the `<title>`), so a primed tour page has only its own. A page served plain (missing bundle, R2 error, budget: 300 ms, or 5 s
for a crawler) gets the site-wide tags back instead, the same as a slug with no live tour. With `?pano=` the image is that scene's, while
`og:url` stays the canonical page.

Scrapers fetch the page and the image anonymously. On dev, `panote.dev/s/*` is behind Cloudflare
Access (below), so every scraper gets a `302` to the Access login and shows at most the bare URL;
`cdn.panote.dev` is public, so the image URLs themselves resolve (checked with the Facebook,
Twitterbot, Slackbot, WhatsApp and LinkedInBot user agents: `200 image/webp`). Previews only work
on production, which has no Access, once `cdn.panote.io` is attached with the same WAF rule. To
check a page's tags on dev, view source in a signed-in browser; on production, use the Facebook
Sharing Debugger, LinkedIn Post Inspector or a Slack DM.

**Admin's assets layout.** Assets build into `dist/app/` so `/app/assets/…` maps onto files, but
the Worker's assets root is `dist/`. Workers' SPA fallback always serves the *root*
`/index.html`, and `_headers` must sit in the root, so admin's Vite config also writes
`dist/index.html` (a copy of `dist/app/index.html`) and `dist/_headers`. `/app` 307s to `/app/`
(`html_handling: auto-trailing-slash`). `wrangler deploy` prints a warning that the routes "will
attempt to serve Assets on a configured path" (`panote.dev/app` → `dist/app`); that is exactly the
intended mapping.

**Config.** Each app commits `.env.dev` and `.env.production` (`VITE_SITE_ORIGIN`,
`VITE_CDN_BASE`, `VITE_AUTH0_DOMAIN`, `VITE_AUTH0_CLIENT_ID`, `VITE_AUTH0_AUDIENCE`,
`VITE_AUTH0_CONNECTIONS`, `VITE_SHOWCASE_SLUG`; admin also has `CSP_UPLOAD_ORIGIN`, the R2 S3
endpoint for presigned PUTs, which only feeds the CSP and is not bundled). `pnpm build` runs
`vite build --mode ${APP_MODE:-dev}`; `deploy.yml` sets `APP_MODE` to the target environment
(declared in each app's `turbo.json`, so turbo passes it through and keys the cache on it). The
build validates the env with `loadConfig` from `@internal/web-kit` and fails on a bad value.
`YOUR_` placeholders parse, and auth then reports itself unconfigured (the admin app shows "Sign-in
isn't set up here" and the website's modal has no buttons): production's tenant domain and client
id are placeholders until the production tenant exists. Dev uses the Auth0 dev SPA application
(client id `DEXWa49LnwVmX8flff1kcxHpj8G0d9d2`, public). The
production deploy guard fails on any `YOUR_` in `apps/*/.env.production`.

**Headers.** The build also emits `_headers` from the env (`buildHeadersFile` in
`@internal/web-kit/build`): a CSP of `default-src 'self'`, `script-src 'self'`,
`style-src 'self'`, `img-src 'self' <cdn> https: data: blob:`, `media-src 'self' <cdn> https:`, `connect-src 'self' <cdn> <auth0 domain>`
(admin adds the R2 S3 endpoint), `frame-src https://www.youtube-nocookie.com https://player.vimeo.com` (admin adds `'self'`),
`object-src 'none'`, `base-uri 'self'`, `form-action 'self'`, plus `nosniff`,
`strict-origin-when-cross-origin` and `Strict-Transport-Security: max-age=31536000;
includeSubDomains` (no `preload`; every host on both zones is HTTPS-only behind Cloudflare, and
HSTS is per host, so the apex's `_headers` covers the `/s/*` and API responses on it too). Every path gets `frame-ancestors 'none'` except the website's
`/s/:slug/embed`, whose rule removes the inherited CSP (`! Content-Security-Policy`) and sets
the same policy with `frame-ancestors *`. Verified under `wrangler dev`: the embed path gets only
the `*` policy, other paths only `'none'`, and SPA-fallback responses carry the headers too.
Vite's `assetsInlineLimit` is 0 so no asset turns into a `data:` URI that the CSP would block.
`/assets/*` (content-hashed) also gets `Cache-Control: public, max-age=31536000, immutable`, so a
returning visitor doesn't revalidate the JS, CSS and fonts; HTML keeps the Workers default
(`max-age=0, must-revalidate`). Admin's assets live under `/app/assets/`, so its Vite config
passes `assetsBase: '/app/'` and its block is `/app/assets/*`. The website build also adds
`<link rel="preconnect" href="<cdn origin>" crossorigin data-cdn-base="<cdn root>">` to
`index.html` (the `cdnPreconnect` plugin in `apps/website/vite.config.ts`).
The embed rule is repeated for `/s/:slug/embed/` (trailing slash). Off production every path
also gets `X-Robots-Tag: noindex, nofollow` (see Search engines below).

**Search engines.** panote.dev must never be indexed; panote.io stays indexable (unlisted tours
add their own `<meta name="robots" content="noindex">`, D5). The signal is the build mode
(`APP_MODE`, see Config): `isIndexable(mode)` in `@internal/web-kit/build` is true only for
`production`, and `buildHeadersFile` adds the header unless it is passed `indexable: true`, so a
missing or new mode fails safe to noindex. Production has to be explicit: `deploy.yml` sets
`APP_MODE=production` for production deploys, and the Vite configs reject any mode other than
`dev`/`production`.

- `_headers` (`/*`, inherited by the embed rule): `X-Robots-Tag: noindex, nofollow` on dev, absent
  on production. Both apps.
- `robots.txt`: each app's build writes `dist/robots.txt` as a real file, so it never falls back
  to the SPA's `index.html`. Dev: `User-agent: *` / `Disallow: /`; production: `Allow: /`. On the
  zone only the website's copy is reachable (admin's routes stop at `/app`); admin's would only
  matter if its `workers.dev` URL were turned back on. `Disallow` alone doesn't keep a URL out of the index (it can still be indexed
  from links), so the header is the real guard. The website's production `robots.txt` also names
  `Sitemap: <VITE_SITE_ORIGIN>/sitemap.xml`; dev's doesn't.
- `sitemap.xml` (website only): production lists `/`, `/privacy` and `/terms` under
  `VITE_SITE_ORIGIN`; tours aren't listed (an unlisted one must not be). Dev writes an empty
  `<urlset>`, so the path is still a real file and never the SPA fallback.
- Link previews and icons: `index.html` has the description, `og:*`/`twitter:*` tags, `theme-color`
  (`#faf8f4`, paper) and the favicon set (`favicon.ico`, `favicon.svg`, `apple-touch-icon.png`,
  from `apps/website/public/`). `og:image` is absolute: the `siteOrigin` plugin in
  `apps/website/vite.config.ts` swaps `%SITE_ORIGIN%` for the mode's `VITE_SITE_ORIGIN`, so a dev
  build points at panote.dev, never panote.io.
- The website's `/s/*` script: `_headers` doesn't apply to Worker-generated responses, so the
  script sets the header itself on the 308 and on whatever `env.ASSETS.fetch` returns, unless the
  wrangler var `INDEXABLE` is `"true"` (dev `"false"`, production `"true"`; missing counts as dev).
- API Workers: not tagged in code. There is no shared response helper in `worker-kit`
  (`upload-api` isn't even on Hono), they return JSON, and the zone rule below covers them.
- CI's `deploy-dry-run` job checks the real dev and production builds' `_headers` and
  `robots.txt`.

**Zone-wide guard (dev zone only).** Pulumi declares it (`noindexAllResponses: true` in
`infra/pulumi/Pulumi.dev.yaml`, never set on production); the steps below are the manual fallback. Covers everything the code doesn't: the API Workers,
`cdn.panote.dev` (R2 tiles and covers) and any future hostname on the zone. It doesn't reach
`*.workers.dev`, which is off for every dev Worker anyway. Never create this on panote.io.

1. Cloudflare dashboard → account → zone **panote.dev** → **Rules** → **Overview** →
   **Create rule** → **Response Header Transform Rule** (older dashboards: **Rules** →
   **Transform Rules** → **Modify Response Header** → **Create rule**).
2. Rule name: `noindex everything on panote.dev`.
3. If incoming requests match: **All incoming requests**.
4. Then: **Modify response header** → **Set static**, header name `X-Robots-Tag`, value
   `noindex, nofollow`. (Set, not Add, so it doesn't duplicate the header the apps already send.)
5. **Deploy**.

Post-deploy checks (each `grep` should print `x-robots-tag: noindex, nofollow` unless noted):

- `curl -sI https://panote.dev/ | grep -i x-robots-tag`
- `curl -sI https://panote.dev/app/ | grep -i x-robots-tag`
- `curl -sI https://panote.dev/s/<old-slug> | grep -iE '^(HTTP|location|x-robots-tag)'`
  (the 308, from the script)
- `curl -sI https://panote.dev/s/<live-slug> | grep -i x-robots-tag`
- `curl -s https://panote.dev/robots.txt` → `User-agent: *` / `Disallow: /` (not HTML), and
  `curl -sI https://panote.dev/robots.txt | grep -i content-type` → `text/plain`.
- After the zone rule: `curl -sI https://panote.dev/api/tours/x/stats | grep -i x-robots-tag` and
  `curl -sI https://cdn.panote.dev/pub/x | grep -i x-robots-tag` (R2's 404; use a real tile URL
  if the error response doesn't show it).
- Production, once it exists: `curl -sI https://panote.io/ | grep -i x-robots-tag` prints
  nothing, and `curl -s https://panote.io/robots.txt` shows `Allow: /`.

CSP notes for the D units:

- No `<style>` elements: `style-src 'self'` would block them. The viewer chrome is React in
  `@internal/ui` with a plain stylesheet (`styles/viewer.css`); the viewer's old vanilla UI
  subpath (`@panote/viewer/ui`), which injected one, has been deleted. Inline `style` set from JS
  (CSSOM) is not affected.
- Hotspot media: Panote only links to it, never hosts it, so images, audio and video load from any
  `https:` host (`img-src`/`media-src`; never `http:`, and the schema only stores `https://` urls).
  YouTube frames only via `www.youtube-nocookie.com` and Vimeo only via `player.vimeo.com`
  (`frame-src`). Media that fails to load becomes an "Open image/audio/video ↗" link instead.
- Admin's CSP adds `frame-src 'self'` for the share modal's embed preview, which loads the
  website's `/s/<slug>/embed` from `VITE_SITE_ORIGIN` (the same origin once deployed). Local dev has
  no `_headers`, so the cross-origin preview from `localhost:5173` isn't blocked there.

**Sign-in (unit C3).** Auth0 SPA flow (Authorization Code + PKCE; `google-oauth2` is the only
connection enabled so far, the others are below) with
rotating refresh tokens cached in localStorage, so both apps share one session on `panote.dev`.
The Auth0 dev SPA application allows callbacks `https://panote.dev/app/callback` and
`http://localhost:5173/app/callback`, and logout URLs `https://panote.dev/`,
`https://panote.dev/app/`, `http://localhost:5173/app/` and `http://localhost:5174/`; refresh-token
rotation is on and the API `https://api.panote.dev` allows offline access.

- The website's modal opens on any page with `?signin=1`; `next` (a path, query kept, e.g.
  `/app/new?resume=1`) is where the callback lands, defaulting to `/app/`.
- `/app/callback` is the only unguarded admin route. It sends `/app/...` targets through the router
  and anything else to the website with a full navigation.
- Every other admin route checks for a session first; signed out goes to
  `/?signin=1&next=<current path>`. If the refresh token dies mid-session (or an API call 401s),
  the admin app reopens sign-in in place and returns to the same page.
- Sign-out goes through Auth0's `/v2/logout` back to the website's `/`.
- CSP: `/authorize` and `/v2/logout` are top-level navigations, which CSP doesn't restrict; token
  refreshes are `fetch` calls to `/oauth/token`, covered by the tenant in `connect-src`. There is no
  silent-auth iframe (`useRefreshTokensFallback: false`), so no `frame-src` entry is needed. The
  avatar is the user's initial, not the Google profile photo, so `img-src` stays as is.

**More sign-in options.** The apps know five connections (`KNOWN_CONNECTIONS` in
`packages/web-kit/src/config.ts`). The social ones show in this order: Google (`google-oauth2`),
Apple (`apple`), Microsoft (`windowslive`), Facebook (`facebook`). GitHub, LinkedIn and Instagram
are not offered (`docs/decisions.md`, "Account linking" row). Email (`email`, Auth0's passwordless
email connection: a one-time code, no social account, no password) shows last, under an "or"
divider. A button is shown only when its connection name is in `VITE_AUTH0_CONNECTIONS`, so today
only Google shows. Turning one on is an account task, done once per Auth0 tenant (dev now,
production when its tenant exists). Below, `<tenant>` is the tenant's domain
(`panote-dev.au.auth0.com` for dev), and every social provider's redirect/return URL is
`https://<tenant>/login/callback`.

Cost: all of this fits Auth0's Free plan (social connections and passwordless email are both
included). Apple is the only provider that costs money: Sign in with Apple needs the Apple
Developer Program ($99/year). The Google, Microsoft and Facebook developer apps are free. Facebook
works for the app's own admins and testers straight away, but before the public can use it Meta
wants the app switched to *Live*, which can mean app review and business verification.

1. **Create the provider's app.**
   - **Apple.** Needs a paid Apple Developer Program membership. In Certificates, Identifiers &
     Profiles: register an App ID with *Sign in with Apple*, then a *Services ID* (this is the
     client id Auth0 asks for), enable *Sign in with Apple* on it with domain `<tenant>` and return
     URL `https://<tenant>/login/callback`. Create a *Key* with *Sign in with Apple* and download its
     `.p8` (once only). Note the Team ID and Key ID. Apple sends the user's name only on their first
     sign-in, and the email may be a private relay address; the apps already cope with neither.
   - **Microsoft.** In the Microsoft Entra admin center → App registrations → New registration:
     supported account types *Accounts in any organizational directory and personal Microsoft
     accounts*, redirect URI (platform *Web*) `https://<tenant>/login/callback`. Copy the
     Application (client) ID and create a client secret under Certificates & secrets. Secrets
     expire (24 months at most): put the expiry in the calendar and rotate it in Auth0 before then.
   - **Facebook.** Free. In Meta for Developers, create an app (use case *Authenticate and request
     data from users with Facebook Login*), add *Facebook Login*, set Valid OAuth Redirect URIs to
     `https://<tenant>/login/callback`. Under App settings → Basic set the privacy policy URL
     (`https://panote.dev/privacy`, `https://panote.io/privacy` for production) and the user data
     deletion instructions URL (the same page: it explains Delete account). Copy the App ID and
     App Secret, and switch the app to *Live* (see the review note above); only `public_profile`
     and `email` are needed.
2. **Add the Auth0 connection.** Auth0 dashboard → Authentication → Social → Create Connection →
   Apple / Microsoft Account / Facebook, and paste the credentials from step 1
   (Apple: Services ID, Team ID, Key ID and the `.p8` contents; the others: client id and secret).
   Request only basic profile and email. Check the connection's name is `apple`, `windowslive` or
   `facebook`: the apps send that exact name. Auth0 offers its own
   developer keys for some providers when the credential fields are left blank; they are for a
   quick try only (the consent screen names Auth0, not Panote, and they carry limits). Never leave
   a production connection on developer keys.
3. **Enable it for the SPA.** On the connection's Applications tab, turn on the tenant's SPA
   application (the one whose client id is `VITE_AUTH0_CLIENT_ID`). Use the connection's *Try*
   button to check a sign-in reaches the callback.
4. **Show the button.** Add the connection name to `VITE_AUTH0_CONNECTIONS` in both
   `apps/website/.env.<env>` and `apps/admin/.env.<env>` for that environment (comma-separated;
   order doesn't matter, the apps sort them), e.g.
   `VITE_AUTH0_CONNECTIONS=google-oauth2,apple,windowslive,facebook,email`, and
   ship that as a PR. Do this last: a button for a connection the tenant doesn't have fails at
   Auth0's `/authorize`.

**Email sign-in (passwordless, one-time code).** "Continue with email" is an ordinary
`loginWithRedirect` with `connection: 'email'`: Universal Login asks for the address, emails a
code and asks for it, then returns to `/app/callback` like any other connection. No `login_hint`
is sent (the apps don't ask for the address themselves), and no password is ever set.

1. **Universal Login.** The tenant must use the (new) Universal Login experience (Branding →
   Universal Login), which is what shows the passwordless prompts for a `connection=email`
   request. Classic Universal Login would need a customised login page instead.
2. **The connection.** Authentication → Passwordless → Email: turn it on, set *OTP* (a code, not a
   magic link), a short expiry (300 s) and code length 6. Edit the email template's from address
   and subject (e.g. "Your Panote sign-in code"); keep the template free of promises the copy rules
   forbid. The connection name stays `email`. On its Applications tab enable the SPA application,
   then add `email` to `VITE_AUTH0_CONNECTIONS` (step 4 above).
3. **A real email provider (Needs you, before anyone outside the team signs in by email).** Auth0's
   built-in email provider is for testing only: it is rate-limited, sends from an Auth0 address,
   and Auth0 doesn't support it for production traffic. Under Branding → Email Provider, set up a
   custom provider and a from address such as `no-reply@panote.io`. Free options: **Amazon SES**
   (the AWS organisation already exists; free tier, then cents per thousand mails; verify
   `panote.io` with SES's DKIM CNAMEs in Cloudflare DNS and request production access to leave
   the SES sandbox) or **Resend** (free tier of a few thousand emails a month; also DKIM/SPF
   records in Cloudflare DNS). Adding the provider's DNS records must not touch the existing MX or
   Email Routing records (see "Email" below). Send a test from the Email Provider page, then sign
   in by email end to end.

**Account linking (one Panote account per verified email).** Signing in with Google, Apple
or an email code with the same verified address lands in the same Panote account. The
work is a post-login Action, kept as code in `packages/auth0-actions/src/link-accounts.cjs` (tests
beside it). Why it links automatically, against Auth0's advice to re-authenticate first, is in
`docs/decisions.md` ("Account linking").

- **Trusted providers only.** `TRUSTED_PROVIDERS` in the Action is the one list: passwordless
  `email` (the code proves the address), `google-oauth2` and `apple`. Both sides must qualify: the
  current login's identity, and each candidate through an identity from a trusted provider that
  carries the same verified email. Microsoft (`windowslive`) and Facebook users sign in
  normally but are never joined, in either direction, until those providers are reviewed; adding
  one is a code change to that list and a new paste of the Action.
- **Who becomes the primary.** On each interactive login it looks up users with that email
  (Management API `users-by-email`, asked for the address as given and in lower case, because the
  lookup is case-sensitive and social connections keep the provider's casing), drops blocked users
  and those without a qualifying identity, and picks the oldest (`created_at`, then `user_id`).
  If that is someone else it links the current user into it
  (`POST /api/v2/users/{primary}/identities`) and, once that call succeeds, calls
  `api.authentication.setPrimaryUser(primary)`, so the token's `sub` is the primary's. If the
  current user is the oldest it does nothing: a newer duplicate is linked the next time that one
  signs in.
- **Concurrent first logins.** A `400` or `409` from the link call means the picture went stale
  (another login linked or created a user a moment ago): it looks the users up once more and
  retries once, unless the deadline has passed.
- **Token claims.** On every login and token refresh it also sets three custom claims on the access
  token (names in `packages/contracts/src/jwt.ts`, which `admin-api` reads):
  `https://panote.io/auth_time`, the latest of the session's authentication method timestamps in
  epoch seconds (not
  on a refresh-token exchange; account delete wants a recent one, see "Account deletion"), and
  `https://panote.io/linked_subs`, the user ids of the identities linked into the user (at most
  10; on the login that links, the primary's plus the one just linked), and
  `https://panote.io/email`, the user's address in lower case, set only when an identity from
  `TRUSTED_PROVIDERS` verified it (the same test linking uses; refreshes included), so a
  Microsoft-only or Facebook-only account has none. Tour invites are accepted against it. These
  need neither the Management API nor its secrets, so they work even while linking itself isn't
  configured. The APIs drop a missing or malformed claim rather than refuse the token, so the
  Workers can deploy before the Action does.
- **Never in the way.** It skips refresh-token exchanges and users that already have linked
  identities (merging two primaries is an operator job). Every Management API call has a 5 s
  timeout, the whole run (retries included) has one 10 s deadline, after which the login goes on
  unlinked (Auth0 stops an Action at about 20 s, which would fail the login) and logs
  `[link-accounts] linking timed out`. A `401` drops the cached M2M token and retries once with a
  fresh one, and any other failure logs `[link-accounts] linking failed` and lets the login go on
  unlinked.

Who won't be joined: Microsoft and Facebook sign-ins (above), an Apple user who chose
*Hide My Email* (the private relay address matches nothing), and anyone whose provider doesn't
report the email as verified. They all still sign in, as their own account.

Setting it up, once per tenant (**Needs you**, all in the Auth0 dashboard):

1. **M2M application.** Applications → Create Application → Machine to Machine, name it
   `link-accounts action`, authorise it for the *Auth0 Management API* with only `read:users` and
   `update:users`. Copy its client id and secret. It is used by nothing else. Never authorise it,
   or any M2M application, for Panote's own API audience: the Workers refuse a client-credentials
   token anyway (`gty: client-credentials` or a sub ending `@clients`, `contracts/src/jwt.ts`),
   but such a token stands for no user.
2. **The Action.** Actions → Library → Create Action → Build from scratch, trigger *Login /
   Post Login*, runtime Node 22 (the newest offered), name `Link accounts by verified email`. Replace
   the editor's code with the whole of `packages/auth0-actions/src/link-accounts.cjs` as it is on
   `main`. It needs no npm dependency (it calls the Management API with `fetch`). Under Secrets add
   `AUTH0_DOMAIN` (the tenant's own domain, e.g. `panote-dev.au.auth0.com`, not a custom domain),
   `MGMT_CLIENT_ID` and `MGMT_CLIENT_SECRET` from step 1. Deploy it.
3. **Add it to the Login flow.** Actions → Triggers → post-login: drag the Action into the flow
   and Apply.
4. **Check it.** Sign in once with Google, then sign out and sign in with an email code to the same
   address: User Management → Users shows one user with both identities, its user id still the
   Google one, and the dashboard shows the same tours. The Action's logs (Monitoring → Logs, or the
   Action's real-time logs) show `[link-accounts] linked email|… into google-oauth2|…`.
5. **When the code changes,** paste the new file over the old in the same Action and Deploy. The
   repo file is the source of truth; never edit the Action in the dashboard only.

Nothing on the API side changes. Workers only check the JWT, and owner keys are
`base64url(sub)` of whatever sub the token carries, so any sub prefix (`apple|…`,
`windowslive|…`, `facebook|…`, `email|…`) works, as do account deletion
and the `delete-account.ts --sub` CLI. After linking, the token's sub is always the primary's, so
the R2 owner prefix of an existing account doesn't move. **Known gap:** a user who already had
Panote data under their own sub before being linked into an older account (only possible for
sign-ins made before the Action was deployed, or while it was failing, since a failed link lets the
sign-in go on unlinked) keeps that data under the old sub, which no token carries any more. It is
not moved, and the editor doesn't list it: the owner can't edit those tours, and any that were
published stay up. Account deletion does reach it, through the `linked_subs` claim (see "Account
deletion"). Failing the sign-in instead of continuing unlinked was considered and rejected: a
Management API hiccup would lock people out of their own account, and the orphaned data is rare
and now deleted with the account. Showing linked subs' tours in the editor is left for later. To
find such data by hand, the `[link-accounts] linked <secondary> into <primary>` log line names both
ids; check `panos/<base64url(secondary)>/` and `tours/<base64url(secondary)>/`.

**Email ban list.** A takedown's `--disable-owner` blocks one Auth0 user id; a second post-login
Action, `packages/auth0-actions/src/ban-list.cjs` (tests beside it), refuses any sign-in, or token
refresh, whose user carries a banned email address (the root email or a linked identity's,
verified or not) with `api.access.deny`, which the admin app's callback page shows as "Sign-in was
cancelled, or this account isn't allowed to sign in." The list is the Action secret
`BANNED_EMAIL_SHA256`: SHA-256 hashes (hex) of normalised addresses, separated by commas, spaces or
newlines, so no plaintext address sits in the tenant config. Normalised means trimmed, lower case,
any `+tag` dropped, and for `gmail.com`/`googlemail.com` the dots dropped too (so
`J.Doe+x@googlemail.com` and `jdoe@gmail.com` are one entry). Missing or empty, nobody is refused.
The log line is `[ban-list] sign-in refused` with neither the address nor the user id; entries
that aren't 64 hex digits (a pasted address, a cut-off hash) are ignored and logged as a count
only (`[ban-list] N BANNED_EMAIL_SHA256 entries are not SHA-256 hashes, ignored`). The hashes are
unsalted SHA-256: they keep addresses out of plain sight in the dashboard, but anyone who can read
the secret can check whether a given address is on the list, so treat the secret as private.

Setting it up, once per tenant (**Needs you**, Auth0 dashboard): Actions → Library → Create Action
→ Build from scratch, trigger *Login / Post Login*, runtime Node 22, name `Block banned emails`.
Paste the whole of `ban-list.cjs` as it is on `main`, add the secret `BANNED_EMAIL_SHA256` (empty
is fine to start), Deploy, and in Actions → Triggers → post-login put it **first**, before "Link
accounts by verified email", then Apply.

Banning someone: look up the address on the Auth0 user (User Management → Users → search the
sub `takedown.ts` printed → its email; a linked user shows each identity's), then

```bash
node packages/auth0-actions/scripts/ban-email.cjs 'person@example.com'
# stderr: hashed as person@example.com   stdout: the 64-hex hash
```

and add the printed hash to `BANNED_EMAIL_SHA256` (Action → Secrets → edit; keep the existing
hashes, comma-separated), then Deploy the Action. Keep which case each hash belongs to in the case
log, not in the secret. To lift a ban, remove that hash and Deploy. `takedown.ts --disable-owner`
prints this step after it disables an owner, since it has no Auth0 access to read the email
itself. A ban list only raises the cost of coming back: a person with a different address still
signs up.

**Local dev.** `pnpm --filter @app/admin dev` serves `http://localhost:5173/app/` (the port the
Auth0 dev SPA app's callback allows) and `pnpm --filter @app/website dev` serves
`http://localhost:5174/`. Both proxy `/api` to `https://panote.dev`, so the APIs stay
same-origin. The two apps run on **different origins** locally (unlike deployed, where both are
`panote.dev`), so an auth `returnTo` path like `/app/t/…` resolves against the admin origin
(`:5173`), and a website sign-in that hands off to `/app/` has to use the admin dev server's
origin. Under `vite dev` the apps use those two origins for callbacks, logout and cross-app links,
and keep the PKCE transaction in a cookie (shared across ports) rather than sessionStorage. Tokens
still live in each origin's localStorage, so locally the website doesn't see the admin's session. `_headers` doesn't apply under Vite; use `wrangler dev --env dev` on a built `dist/` to
check headers and SPA fallback.

**Deploy.** `deploy.yml`'s `deploy-apps` matrix job (`website`, `admin`) `needs:
resolve-environment` and runs only when it says `proceed`, so it shares every gate with the other
deploy jobs: `DEV_AUTO_DEPLOY`, the main-tip check, the production guards. It checks out the
commit CI verified (`workflow_run.head_sha`), builds with `turbo run build
--filter="@app/<app>..."` and `APP_MODE=<env>`, then runs `wrangler deploy --env <env>`. CI's
`deploy-dry-run` job dry-runs both apps with `--env dev` and, against their production builds, `--env production`. The existing `CLOUDFLARE_API_TOKEN`
scopes (Workers Scripts + Routes) should cover assets-only Workers; confirm on the first deploy.

**Status: not deployed yet.** The first dev deploy happens through `DEV_AUTO_DEPLOY` when this
lands on `main`. After it, check:

- `curl -I https://panote.dev/` → 200 with the website's CSP.
- `curl -I https://panote.dev/app/t/anything` → 200 (deep link hard-refresh), `/app` → 307 to
  `/app/`.
- `curl -i https://panote.dev/api/admin/panos` → still **401** without a token (route
  precedence), likewise `/api/tours/<id>/stats` still answers from `public-api`.
- `curl -I https://panote.dev/s/x/embed` → `frame-ancestors *`; any other path → `'none'`.
- Sign in with Google from `https://panote.dev/?signin=1` → lands on `/app/` with the account
  menu; the access token is a JWT (three dot-separated parts) and `GET /api/admin/tours` with it
  returns 200. Sign out returns to `https://panote.dev/`.

Production is unprovisioned, like the rest (see Production runbook).

---

## One-time provisioning

**Pulumi takes this over.** `infra/pulumi` declares the bucket, its CORS, the r2.dev URL (off),
`cdn.<zone>`, the R2 → queue notification, both queues, the zone's WAF, rate-limit, cache and
response-header rules, HSTS, URL normalization and the apex record, for dev and production, and
will manage them from the first `pulumi up` of each stack (not run yet). [`infra/README.md`](../infra/README.md) is the entry point: install, state backend,
importing dev, creating production. The commands below are the manual fallback and the record of
how dev was first built; anything changed with them by hand shows up as drift in the next
`pulumi preview`.

Account-level commands (bucket, queues, notification, CORS) work from any Worker package —
`wrangler` is a devDependency of each `services/*` workspace, not a global install. Commands
below run through `@service/admin-api`; any of the four would do. All commands below assume
you're running them from the repo root — `pnpm --filter <pkg> exec <cmd>` runs `<cmd>` with the
matched package's directory as its cwd (not the repo root), which is why a relative
`--file` path below is `../../infra/r2/cors.json` rather than `infra/r2/cors.json`.

**Status as of 2026-09-25: dev is fully provisioned, production is not.** `pano-content-dev`,
`pano-uploads-dev`, and `pano-uploads-dlq-dev` already exist (inherited from pano-viewer's
provisioning); bucket CORS, the `cdn.panote.dev` custom domain and its WAF rule, the R2 secrets,
and the Auth0 dev tenant are now in place too (see each subsection below). `pano-content`,
`pano-uploads`, and `pano-uploads-dlq` do not exist for production. `panote.io` moved from Route
53 to Cloudflare on 2026-09-26 (see DNS section), which clears the one blocker that kept
production provisioning from starting at all — but none of the steps below have actually been
run against production yet, and production is still unprovisioned for other reasons too (no
production Auth0 tenant, no `PRODUCTION_PROVISIONED` repository variable — see Production runbook
below, which runs these steps for production in order). The `production` GitHub Environment itself already exists, with a required reviewer and a
main-only branch policy, and holds `CLOUDFLARE_API_TOKEN`.

None of `r2 bucket create` / `queues create` / `r2 bucket notification create` take a
`--if-not-exists` flag (checked via `--help` against wrangler 4.120). Re-running `create`
against an existing bucket or queue fails loudly with an "already exists" error rather than
duplicating it — safe to re-run when unsure of current state, but read the error rather than
assuming success. The notification command has no visible dedup key, and `--help` doesn't document what happens
if you create an identical rule twice — whether it's rejected, silently replaces the existing
one, or both rules fire independently. A second identical rule may double-fire the queue message
per upload rather than erroring, so before re-running it, check
`wrangler r2 bucket notification list <bucket>` first rather than assuming it's safe.

### Bucket + queues

```bash
# dev — already done, listed for reference
pnpm --filter @service/admin-api exec wrangler r2 bucket create pano-content-dev
pnpm --filter @service/admin-api exec wrangler queues create pano-uploads-dev
pnpm --filter @service/admin-api exec wrangler queues create pano-uploads-dlq-dev

# production — outstanding (Production runbook, step 1)
pnpm --filter @service/admin-api exec wrangler r2 bucket create pano-content
pnpm --filter @service/admin-api exec wrangler queues create pano-uploads
pnpm --filter @service/admin-api exec wrangler queues create pano-uploads-dlq
```

### R2 → queue notification

Fires a queue message whenever an `original` lands under `panos/`. This is the one piece of
dev provisioning done *out of band* by pano-viewer, not by anything in this repo — it targets
the queue directly, not a Worker, so it keeps working unchanged across the consumer cut-over
below.

```bash
# dev — already exists (created by pano-viewer)
pnpm --filter @service/admin-api exec wrangler r2 bucket notification create pano-content-dev \
  --event-type object-create --prefix "panos/" --suffix "/original" --queue pano-uploads-dev

# production — outstanding (Production runbook, step 2)
pnpm --filter @service/admin-api exec wrangler r2 bucket notification create pano-content \
  --event-type object-create --prefix "panos/" --suffix "/original" --queue pano-uploads
```

### Bucket CORS

`wrangler r2 bucket cors set <bucket> --file <path>` (checked via `--help` against wrangler
4.120) expects Cloudflare's own R2 API shape — a top-level `rules` array of
`{ "allowed": { "origins", "methods", "headers" }, "maxAgeSeconds" }` objects, lowercase keys,
nested under `allowed`. It rejects an AWS S3-style file (`CORSRules`, or bare `AllowedOrigins`/
`AllowedMethods`/`AllowedHeaders` keys) outright with a pointer to
<https://developers.cloudflare.com/r2/buckets/cors/#example> — pano-viewer's `services/cors.json`
was in that now-rejected S3 shape, so it's been converted rather than copied verbatim. The
converted file lives at `infra/r2/cors.json`: GET (public tile/manifest reads, `content-type`
header, 24h preflight cache) and PUT (presigned uploads, `content-type`, `if-match` and
`if-none-match` headers, 1h preflight cache), origins `https://panote.dev` and
`https://panote.io`. The two conditional headers make each upload URL single-use (Owner quotas,
"Single-use upload URLs"); a bucket whose ruleset predates them fails every upload's preflight,
so re-apply the file whenever it changes. This command always replaces the
whole ruleset (prompts for confirmation unless `--force`), so it's genuinely safe to re-run.

```bash
pnpm --filter @service/admin-api exec wrangler r2 bucket cors set pano-content-dev \
  --file ../../infra/r2/cors.json
# production, once the bucket exists (Production runbook, step 3):
pnpm --filter @service/admin-api exec wrangler r2 bucket cors set pano-content \
  --file ../../infra/r2/cors.json
```

Pulumi applies `cors.json` to the bucket on every `up` (the file stays the single source), so the
commands above are the fallback. **Status: needs re-applying to dev, outstanding for production** — `pano-content-dev`'s CORS
ruleset was set from `infra/r2/cors.json` before the PUT rule gained `if-match` and
`if-none-match`: run the dev command above again before, or together with, the upload-api deploy that signs them, or uploads fail at the
preflight. `pano-content` doesn't exist yet. Rollback: this command always
replaces the whole ruleset, so undoing a bad change is just re-running it with the previous
`cors.json` (from git history).

**Dev-only variant.** `infra/r2/cors.dev.json` is `cors.json` plus `http://localhost:5173` and
`http://localhost:5174` on both rules, so the local Vite app can hit presigned URLs directly. It
is for `pano-content-dev` **only** — never run this against `pano-content` (production), which
must stay on `cors.json`'s origins.

```bash
# pano-content-dev only. NOT applied yet.
pnpm --filter @service/admin-api exec wrangler r2 bucket cors set pano-content-dev \
  --file ../../infra/r2/cors.dev.json
```

### CDN custom domain (MANUAL)

#### Prerequisite: WAF custom rule, before attaching the domain

The bucket also holds `panos/<owner>/<panoId>/original` and `panos/<owner>/<panoId>/config.json`
— owner-scoped, never meant to be publicly readable. An R2 custom domain serves the *whole*
bucket with no per-prefix access control, so before attaching `cdn.panote.dev`, create a WAF
custom rule on the `panote.dev` zone (dashboard: Security → Security rules (custom rules); or the Rulesets
API, phase `http_request_firewall_custom` — `wrangler` cannot create WAF rules), action **Block**,
expression:

```
(http.host eq "cdn.panote.dev" and not (starts_with(http.request.uri.path, "/tiles/") or starts_with(http.request.uri.path, "/pub/") or starts_with(http.request.uri.path, "/slugs/")))
```

Fail-closed: any future private prefix is blocked by default, since only the three named public
ones are allowed through. Custom rules run before the cache, so a cached private object can't
slip out through this domain even if one somehow ended up cached — per Cloudflare's cache docs,
"A WAF custom rule was triggered to block a request. The response will come from the Cloudflare
global network before it hits cache." The Free plan allows 5 custom rules; this uses 1. URL
normalization (Rules → Settings) is enabled on the zone, verified live against `cdn.panote.dev` on
2026-09-25: `/panos`, `/tours`, and `/` all return `403`; `/tiles`, `/pub`, and `/slugs` pass
through to R2; and `/tiles/../panos/` also returns `403`, confirming the path-traversal trick can't
slip past the check. Mirror the same rule for `cdn.panote.io` on the `panote.io` zone in
production, host `cdn.panote.io`, before attaching that domain.

Pulumi declares this rule (and a second one blocking any query string on the CDN) in
`infra/pulumi/src/rules.ts`, and attaches the domain only after the ruleset exists.

#### Attaching the domain

Do this once per environment, only after the WAF rule above exists. Dashboard: the bucket's
Settings → Custom Domains. `wrangler r2 bucket domain add` is a scriptable alternative to the
dashboard:

```bash
pnpm --filter @service/admin-api exec wrangler r2 bucket domain add pano-content-dev \
  --domain cdn.panote.dev --zone-id <panote.dev zone id>
```

- dev: `cdn.panote.dev` → `pano-content-dev`
- production: `cdn.panote.io` → `pano-content`

This is what `docs/decisions.md` calls "an R2 custom-domain CDN" for large binary reads (tiles,
manifests) — cached public reads, zero egress, and it never exposes the raw bucket or `r2.dev`
URL. **Status: live in dev, outstanding in production** — `cdn.panote.dev` is attached to
`pano-content-dev` with its WAF rule in front (verified above); `pano-content` doesn't exist yet
for the production side.

### Secrets

`upload-api` and `tiler-consumer` each need an R2 API token scoped to the bucket with Object
Read & Write permission, split into two secrets:

```bash
pnpm --filter @service/upload-api exec wrangler secret put R2_ACCESS_KEY_ID --env dev
pnpm --filter @service/upload-api exec wrangler secret put R2_SECRET_ACCESS_KEY --env dev
pnpm --filter @service/tiler-consumer exec wrangler secret put R2_ACCESS_KEY_ID --env dev
pnpm --filter @service/tiler-consumer exec wrangler secret put R2_SECRET_ACCESS_KEY --env dev
pnpm --filter @service/tiler-consumer exec wrangler secret put ALERT_EMAIL_TO --env dev
```

`ALERT_EMAIL_TO` is the recipient of the DLQ alert email (see "Tiling failure marker and alerting"
below) and of the health check's alerts (see "Monitoring and alerts"). It's a secret only to keep the owner's personal address out of the repo; it must be
byte-identical to a verified Email Routing destination address on the account — a Gmail `+tag`
variant counts as a *different* address, and a mismatch makes `send()` fail with
`E_RECIPIENT_NOT_ALLOWED`, since `panote.io` isn't onboarded to Email Sending and only verified
destinations are allowed. Unset, the consumer skips the email with a warning and everything else
works.

Repeat with `--env production` once production is provisioned. `public-api` takes one secret,
`LIKER_HASH_KEY` (see "Likes" below; optional in dev, required for likes in production):

```bash
openssl rand -base64 32 | pnpm --filter @service/public-api exec wrangler secret put LIKER_HASH_KEY --env dev
```
`admin-api` reads R2 through the native binding, not the S3 API, but needs `CF_ANALYTICS_TOKEN`
for tour insights (see "Insights (unit B5)" below), the optional `CF_PURGE_TOKEN` (see "CDN
purge on delete" below) and the optional `OPERATOR_TOKEN` (see "Takedown" and "Backups" below;
unset, the operator routes answer `404`). `wrangler deploy --env <env> --secrets-file <file>` is the alternative to
interactive `secret put` if scripting this. **Status: set for dev, outstanding for production** —
`R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY` are set on `upload-api` and `tiler-consumer`'s dev
environments; production has neither yet. `CF_ANALYTICS_TOKEN` and `CF_PURGE_TOKEN` are set on
`admin-api`'s dev environment, outstanding for production. `ALERT_EMAIL_TO` is set on
`tiler-consumer`'s dev environment, to the owner's verified Email Routing destination (a `+tag`
Gmail variant — must be byte-identical to the verified address; not written here), outstanding
for production.

### CDN purge on delete (unit B6)

After a pano delete (tiles swept), a tour delete, or an unpublish, `admin-api` calls
`POST /zones/<CDN_ZONE_ID>/purge_cache` from `ctx.waitUntil`, so the `204` never waits on it.
A pano delete purges by prefix (`cdn.panote.dev/tiles/<panoId>/`); a tour delete batches every
pano it removed into one prefix request (100 max each), and purges the tour's floor-plan images
(`pub/plans/<tourId>/<planId>.<ext>`) by URL; unpublish purges `pub/tours/<tourId>.json`
and the removed `slugs/<slug>.json` by URL. An unpublish leaves the tiles: they live owner-free at
`tiles/<panoId>/` and stay public on the CDN, so anyone who already viewed the tour (and so knows the
panoIds) can keep loading its images until the pano is deleted. That is by design (re-tiling on
every unpublish would cost a full tiling job); the owner is told so in the Stop sharing confirm and
on the privacy page. A tour save that leaves a plan image unused (replaced
or removed, and no longer on the share link) deletes and purges it by URL too, once it is an hour
old, and so does the daily sweep of plan images nobody saved ("Unsaved floor-plan images").
A `429`, a `5xx`, a network error or the 5s timeout is retried twice in the request (after
1s and 4s, or the `Retry-After`, capped at 10s), and a purge stops starting requests 20s after
it began (`DEFAULT_DEADLINE_MS`), so one in `waitUntil` always has time left to queue the rest
and record the failure. Each failure is logged (`cdn purge failed …`,
status and Cloudflare error codes only). A batch that still fails after its retries stops the
rest of the purge, since that is a rate limit or an outage rather than the batch: a `429` stops
only its own kind (prefix or URL, which have separate budgets), anything else stops both. What
failed or wasn't sent is queued, as R2 keys, in `ops/cdn-purge/pending/<ISO time>-<uuid>.json`
(`{ v, firstAt, prefixes, files }`, at most 1,000 items a record); an operator takedown's go
under `ops/cdn-purge/pending/0-op/`, which lists first, so they are retried first. A batch Cloudflare refuses
outright (a `4xx` other than `401`, `403` or `429`, such as a `400`, which would fail the same way
again) is not queued but dead-lettered to `ops/cdn-purge/dead/` (same shape, plus `reason`). A
`401`/`403` is the token (`CF_PURGE_TOKEN` expired or revoked), not the batch: it is not retried in
the request, stops the rest of the purge, and everything is queued, so the queue drains on its own
once the token is replaced; meanwhile every run fails one request and the `cdn purge` check keeps
alerting. The 15-minute cron (the
backup's, `*/15 * * * *`) retries the queue: it reads the 20 oldest records, merges them (so a
burst of pano deletes becomes one prefix request per 100 panos), sends at most 30 requests with no
in-run retry, then deletes a record once everything in it went through, moves one that failed
this run to the back of the queue (a new key, so it can't hold up the records behind it), and
trims one in place to what wasn't tried. What Cloudflare refuses outright, and a record still
failing after 7 days (`cdn purge given up after 7 days`), go to `ops/cdn-purge/dead/` and alert.
The queue is capped at 1,000 records: past that, each run drops the 200 oldest owner records
after its own (never a takedown's) in one batch delete, logs `cdn purge queue over 1000 records`
and alerts; those edge copies stay until their TTL. A run makes at most 97 subrequests
(`RETRY_RUN_MAX_SUBREQUESTS`). It runs first in the 15-minute invocation; the backup, the tile
sweep and the sweep's status then share the other 803 (`FIFTEEN_MINUTE_RUN_OPS`, passed to
`runBackupThenTileGc` as `totalOps`), so the invocation makes at most 900
(`BACKUP_RUN_BUDGET`), under the 1,000 per-invocation limit: the cap holds because every part is
capped. Anything else that comes to share the invocation must come out of those 900, not add to them.
With the token unset or `CDN_ZONE_ID` not a real 32-hex id it logs `cdn purge skipped`, does
nothing and queues nothing (the cron leaves the queue alone too).

**Dead letters.** Anything under `ops/cdn-purge/dead/` was never purged: list it
(`wrangler r2 object` or the dashboard), purge the URLs by hand (the zone → Caching →
Configuration → Custom Purge; a key `k` is `https://cdn.<host>/k`, a prefix `cdn.<host>/k`), fix
the cause (`reason`), and delete the record.

Free plan limits (Cloudflare's purge-cache docs): prefix, tag and host purges are 5 requests a
minute, bucket 25, **per account**, so dev and production share them; single-file (URL) purges
are a separate, far larger budget (800 URLs a second); both take at most 100 items a request.
So a pano delete purges its tiles by prefix, and a burst past the budget gets `429`s, which the
queue absorbs. The operator takedown purges every tile **by URL** instead (see Takedown), so no
one's deletes can stand between a takedown and its purge. `PANO_DELETE_LIMITER` (10 pano or tour
deletes a minute per owner, Rate limits) is only a cost cap: one owner, or a few, can still use
up the prefix budget, and that is what the queue and the URL purge are for.

Ops steps, per environment:

1. Create an API token (My Profile → API Tokens → Custom token) with **Zone → Cache Purge →
   Purge**, scoped to the one zone (`panote.dev` for dev, `panote.io` for production).
2. `pnpm --filter @service/admin-api exec wrangler secret put CF_PURGE_TOKEN --env dev`
3. Set `CDN_ZONE_ID` in `services/admin-api/wrangler.jsonc` to the zone's id (dashboard: the
   zone's Overview → API → Zone ID), then redeploy. Dev's is `2196d8dead0322ad69307711fc72b5d3`.
4. Check: fetch a tile twice until `cf-cache-status: HIT`, delete its pano, and the next fetch is a
   `MISS`/`404`.

**Status: set for dev, outstanding for production** — the dev `CDN_ZONE_ID` is set and
`CF_PURGE_TOKEN` has been set on dev. Step 4 passed in dev on 2026-10-08: a test pano's tile and
`preview.webp` were `HIT` (`age: 3689`) on `cdn.panote.dev`, `DELETE /api/admin/panos/:panoId`
returned `204`, and 20s later both came back `404` (`cf-cache-status: BYPASS`), the manifest
`404`. admin-api logged no `cdn purge failed`/`skipped` line, and it logs nothing on success. The
first `DELETE`, right after upload, got `409` from the recent-upload guard, so wait an hour.
Production has no token and `CDN_ZONE_ID` is still `YOUR_PANOTE_IO_ZONE_ID`.

### CDN cache rules

Cache Rules on the CDN zone live in `infra/cloudflare/cache-rules.<env>.json` (the Rulesets API's
own shape) and Pulumi applies them as the zone's whole `http_request_cache_settings` ruleset
(`infra/README.md`). The ruleset is replaced as a unit, so a rule made in the dashboard is
removed by the next `up`: add it to the file instead. `apply-cache-rules.sh`, which upserted the
file into the live ruleset, is gone; Pulumi superseded it. Manual fallback: Rules → Cache Rules in
the dashboard, mirroring the file.

The managed rule today is `panote-json-edge-cache`: on `cdn.panote.dev`, `/slugs/*` and `/pub/*`
are eligible for cache with the edge TTL taken from the origin (`max-age=30` from the R2 binding
writes) and a `404` never stored. The staleness bound is the same 30s the browser cache already
has, and unpublish purges both URLs (CDN purge on delete, above). `manifest.json` is left out on
purpose: after an image replace, admin's `refreshManifestCache` only refreshes the browser's copy,
so an edge copy would keep the old manifest for up to 30s. The tour page primes the start
manifest anyway (Tour page priming, above).

**Status: written, not applied.** The first dev `pulumi up` (infra/README.md, steps 7-9) applies
it, and replaces the dashboard's `tiles-404-short-ttl` with `panote-tiles-404-no-store`, the rule
production uses for the same thing. After applying, check:
- `curl -sI https://cdn.panote.dev/slugs/<live-slug>.json` twice: the second is
  `cf-cache-status: HIT`.
- `curl -sI https://cdn.panote.dev/slugs/no-such-slug.json`: `404`, never `HIT`.
- The same slug URL with `-H 'Origin: http://localhost:5174'` and then `-H 'Origin:
  https://panote.dev'` each gets its own origin back in `access-control-allow-origin` (a cached
  CORS header must not leak across origins; tiles already work this way).
- A tile 404 is still `BYPASS` and a manifest is still `DYNAMIC`.

Rollback: take the rule out of the JSON and `pulumi up`.

Production has its own `cache-rules.production.json` (hosts `cdn.panote.io`). The program refuses
a rule whose host isn't the stack's `cdn.<zone>`, so dev's file can't land on production.

---

## DNS / zone setup

- **`panote.dev`** — **live on Cloudflare as of 2026-09-25**: nameservers `jo.ns.cloudflare.com`
  and `kaiser.ns.cloudflare.com`, zone Active, with the placeholder proxied `AAAA @ 100::` record
  in place; the website and admin Workers' routes will serve it after the first deploy (see Frontends). `admin-api`, `public-api`, and `upload-api`'s
  dev `routes` blocks all target `panote.dev`, and their first dev deploy (see the checklist
  below) already succeeded against it. Their `*.workers.dev` URLs are off from the first dev
  deploy after 2026-10-08, so the route is the only way in.
- **`panote.io`** — **moved from AWS Route 53 to Cloudflare on 2026-09-26**: same nameservers as
  `panote.dev` (`jo.ns.cloudflare.com` / `kaiser.ns.cloudflare.com`), set at the registrar
  (Namecheap), with the .io registry delegating to them at ~05:48 UTC. Zone is on the Free plan.
  No web records exist yet — no A/AAAA/CNAME — so there's nothing for a production route to
  attach to until production provisioning creates them. The old Route 53 zone carried
  `issue`/`issuewild "amazon.com"` CAA records left over from an abandoned ACM/CloudFront plan;
  they weren't carried over, and nothing Amazon-only should be added back to the Cloudflare
  zone — an Amazon-only CAA record would block Cloudflare from issuing its own certificate for
  the zone. This move clears the DNS blocker on production provisioning (see Production runbook
  below); production remains otherwise unprovisioned.
- The old Route 53 hosted zone for `panote.io` (in the panote AWS management account) was deleted
  on 2026-09-26, via a targeted `pulumi destroy` of the zone and its three records in the legacy
  Pulumi `management` stack (archived `pano-viewer` repo, `legacy/aws-pulumi`). The rest of the
  panote AWS organization — management/dev/prod/log-archive accounts, SCPs, CloudTrail, budgets,
  GitHub OIDC roles — is kept on purpose. That stack's code still wires in `deployDns()`, so a
  future `pulumi up` of `management` would recreate the zone unless that wiring is removed first
  (noted locally in that checkout's `SUPERSEDED.md`, since the repo is archived).

### Email

`*@panote.io` mail now goes through Cloudflare Email Routing: a single catch-all rule forwards
every address to the owner's personal inbox (not recorded here). Records: MX
`route1/2/3.mx.cloudflare.net`, SPF `v=spf1 include:_spf.mx.cloudflare.net ~all`, DKIM at
`cf2024-1._domainkey`. This replaces ImprovMX, a third-party forwarder: `panote.io` was deleted
from ImprovMX on 2026-09-26.
The catch-all is load-bearing, not cosmetic: the AWS organization's root-user emails
(`aws-root@panote.io`, plus-addressed `aws-root+dev@`/`+prod@`/`+logarchive@`), the
billing/security/ops contact addresses, and the Cloudflare account login itself are all
`@panote.io` — don't remove the catch-all or change the MX records without a replacement already
in place, or account recovery breaks.

`panote.dev` email is a separate, open follow-up: its MX records still point at Namecheap's
eforward, which stops working once a domain's nameservers leave Namecheap — so `panote.dev`
inbound mail is likely already broken. Nothing depends on it yet; moving it to Cloudflare Email
Routing too hasn't been done.

### Cloudflare Access (dev only)

Since 2026-10-06, `panote.dev` is behind Cloudflare Access so the dev site isn't public. Account
`12e2809e05de8a2bf20b815fd394ec9a`, team domain `panote.cloudflareaccess.com`. Two Access apps:

- **`panote dev`** — all paths on `panote.dev`. App id `710a2ec4-94f4-4854-968f-abb417d85562`,
  allow policy `13e2a4b2-0f77-4d85-9d03-424275251124` (two of the owner's email addresses, not
  recorded here), One-time PIN login, 24h session.
- **`panote dev api bypass`** — `panote.dev/api/*`. App id
  `374172f5-7ce6-4e33-afb8-708bbed65cb5`, a bypass-everyone policy. It's required: the API
  Workers are path-routed on `panote.dev`, so without it every `/api/*` call (including the SPA's
  own, which carry an Auth0 bearer, not an Access cookie) would be redirected to the Access login.

A page `curl` against `panote.dev` now gets a `302` to `panote.cloudflareaccess.com` — expected,
not an outage. `/api/*` still answers directly (e.g. `GET /api/tours/x/stats` → `200`,
`GET /api/admin/panos` with no token → `401`, checked 2026-10-07). Not covered: `cdn.panote.dev`,
which stays public. The dev `*.workers.dev` URLs and Preview URLs used to bypass Access too; they
are off from the first dev deploy after 2026-10-08 (`workers_dev: false`, `preview_urls: false`
in every dev env block). Smoke tests go through `panote.dev/api/*`, which the bypass app keeps
open. To turn them back on, set both to `true` in the dev env blocks and redeploy. Undo: `DELETE
/accounts/<account>/access/apps/<id>` for each app. Never apply this to `panote.io`.

---

## GitHub setup

`.github/workflows/deploy.yml` has two triggers: `workflow_dispatch` (a single `environment`
choice input, default `dev`) and `workflow_run`, which fires after every completed run of `CI`
on `main` (a `workflow_run` trigger only fires from the default branch's copy of a workflow, so
none of this takes effect until this file itself is merged to `main`). A `workflow_run` event
only actually deploys when every one of these holds, checked in the `resolve-environment` job's
gate: `CI` **concluded** `success` (not merely completed); `CI` was triggered by a `push` (so
its weekly `schedule` run and a manual `workflow_dispatch` run of `CI` itself never deploy); the
run's head repository is this one (so a fork's `CI` run can never trigger it); and the
repository variable `DEV_AUTO_DEPLOY` is the literal string `true`. Even then,
`resolve-environment` re-checks that the commit `CI` ran against is still `main`'s current tip
(`gh api repos/<owner>/<repo>/commits/main`) — two pushes' `CI` runs can finish out of order, so
without this check, a `CI` run for an older commit finishing late would redeploy it over a newer
commit that's already live. If it isn't the tip, the run emits a `::notice::` naming both SHAs
and skips the deploy jobs rather than failing. A `workflow_run` deploy always targets `dev` — it
can never resolve to `production` — and deploys the exact commit `CI` verified
(`github.event.workflow_run.head_sha`), not whatever `main` has moved to since. Before the queue
cut-over below, `dev`'s `tiler-consumer` couldn't attach to `pano-uploads-dev` while the old
pano-viewer `pano-tiler-dev` Worker still held the slot (a queue allows exactly one consumer), so
an automatic dev deploy would have failed on every trigger (see the `deploy-tiler-consumer` job
comment) — that's why every deploy, dev included, stayed a deliberate manual action until then.
Every deploy, `dev`
included, is hard-guarded to `main` — the `resolve-environment` job's "Guard deploys to main"
step fails the run with an `::error::` annotation if `github.ref` isn't `refs/heads/main`, so a
`workflow_dispatch` from any other branch never gets the `dev` token (it is on the same
Cloudflare account as production and can't be scoped to dev's resources). `production` also
hard-stops
unless the repo variable `PRODUCTION_PROVISIONED` is the literal string `true` (the
`resolve-environment` job's "Fail unless production is provisioned" step) — and fails closed if
any of the four services' or two apps' `wrangler.jsonc` `env.production` block, or either app's
`.env.production`, still contains a `YOUR_` placeholder anywhere (the `resolve-environment` job's "Fail if any production config still has a
YOUR_ placeholder" step). That's a single case-insensitive check, run once for all four services'
and both apps' configs (and the apps' `.env.production`) rather than duplicated per deploy job: `deploy-workers`, `deploy-tiler-consumer` and
`deploy-apps` all `need: resolve-environment`, so this one check failing blocks every deploy job, including
`deploy-tiler-consumer` — whose own `wrangler.jsonc` has no `OAUTH_ISSUER` var to trip a
per-service check, and would otherwise deploy to production regardless of the other three
services' placeholders. Before this workflow can succeed:

- GitHub Environment `dev` (created automatically on first use if it doesn't exist yet), with a
  deployment-branch policy restricted to `main`, the same as `production`'s, so the `dev` secret
  is only released to a job running from `main` even if the workflow guard is edited away on a
  branch.
- GitHub Environment `production`, with required reviewers configured and a
  deployment-branch policy restricted to `main` — the approval gate the workflow relies on. The
  `resolve-environment` job's "Guard deploys to main" step is a workflow-level backstop, not
  a substitute for this Environment protection rule.
- `CLOUDFLARE_API_TOKEN` as an environment secret on **both** `dev` and `production` (scoped
  separately per environment, even though today both would point at the same Cloudflare
  account). The token needs Workers Scripts, Workers Routes, Containers, Queues, and R2 edit
  permissions.
- `CLOUDFLARE_ACCOUNT_ID` as a repository variable (not per-environment — one account for both).
- Optional: GitHub Environment `infra-preview` with the secrets `infra-preview.yml` needs to run
  `pulumi preview` on pull requests (listed in `infra/README.md`, CI preview). Without them the
  workflow ends with a notice.
- `PRODUCTION_PROVISIONED` as a repository variable, set to the literal string `true` **only**
  once steps 1-11 of the Production runbook below are done (step 12 is setting it). Until then, leave it unset or anything other than `true` — the
  `resolve-environment` job's "Fail unless production is provisioned" step is a hard stop
  otherwise, independent of the main-only guard and the `YOUR_` placeholder check above.
- `DEV_AUTO_DEPLOY` as a repository variable, set to the literal string `true` only once both
  the first dev deploy checklist below and its queue cut-over step have succeeded by hand — done
  on 2026-09-26, so `DEV_AUTO_DEPLOY` is now `true` and dev deploys automatically after `CI`
  succeeds on `main`. Before that, `tiler-consumer` couldn't attach to `pano-uploads-dev` (the
  old pano-viewer `pano-tiler-dev` Worker held the slot), so an auto-deploy triggered before the
  cut-over would have failed on every `CI` success on `main`. **Known gap (accepted):** auto-deploy
  has no pre-deploy check specific to `tiler-consumer`/queue-consumer changes — a change there
  deploys straight to the live dev queue on the next green `CI` run on `main`, same as any other
  service.

After every deploy, dev included, a `smoke-test` job (needs all the deploy jobs) curls public
URLs on the environment just deployed, with no secrets: `GET /api/tours/x/stats` → `200`,
`/api/admin/panos` and `POST /api/upload-url` with no token → `401`, the CDN's `/panos/x`,
`/tours/x` and `/` → `403` (the WAF rule) and a missing `/tiles/` key → `404` (not blocked). On
production it also checks `/`, `/app/` and `/robots.txt` → `200`; on dev those are behind
Cloudflare Access, so it doesn't. Each check gets three tries 10s apart. A red smoke test means
the deploy went out and something answers wrongly: see Rollback.

---

## First dev deploy checklist

**Status: all six steps complete in dev as of 2026-09-26.** Steps 1-4 completed on 2026-09-25 —
`public-api`, `admin-api`, and `upload-api` were deployed to dev via the Deploy workflow
(`.github/workflows/deploy.yml`, `workflow_dispatch`), and the smoke tests in step 4 passed. That
same workflow run (GitHub Actions run `36113701026`) also ran `deploy-tiler-consumer`, which failed
as expected at the queue-consumer attach step — `pano-tiler-dev` still held `pano-uploads-dev`'s one
consumer slot — but got far enough to create `tiler-consumer`'s Worker script and container first.

Step 5's queue cut-over ran on 2026-09-26 at ~03:35 UTC: `pano-tiler-dev` was removed as
`pano-uploads-dev`'s consumer, then Deploy workflow run `36215364076` (`workflow_dispatch`, `dev`)
redeployed all four Workers from `main` — every job green, `tiler-consumer` included.
`pano-uploads-dev`'s consumer is now `worker:panote-tiler-consumer-dev`. The R2→queue notification
rule (prefix `panos/`, suffix `/original` → `pano-uploads-dev`) needed no change. The step 4
smoke tests were re-run against the redeploy: public stats `200`; `admin-api`/`upload-api` with
`Authorization: Bearer x` → `401`, logging `auth rejected: malformed jwt` with no placeholder-issuer
line (confirming dev's real JWKS path runs, not the placeholder-issuer guard).

Step 6's end-to-end test ran immediately after, ~03:43-03:48 UTC, using an Auth0 M2M test token
from the `panote-dev` tenant — see the step 6 status note below for the full result. The steps
below stay as the reference procedure for re-running any of this, not just history.

In order:

1. **DNS prerequisite**: confirm `panote.dev` is an **Active** zone in Cloudflare (see DNS / zone
   setup above), and create the placeholder proxied `AAAA @ 100::` record if it doesn't exist
   yet. `wrangler deploy` attaches each Worker's declared `routes` block as part of the deploy —
   it fails if the zone isn't on the account — so this has to be done first, not worked around by
   `workers_dev`.
2. **Build**: `pnpm build`, or `pnpm exec turbo run build --filter=@service/<svc>...` per
   service. All three plain Workers (`public-api`, `admin-api`, `upload-api`), not just
   `tiler-consumer`, need this — each imports `@internal/worker-kit` and/or
   `@internal/contracts`, whose `package.json` `exports` point at their (gitignored) `dist/`
   output. A service's own `build` script being a no-op ("wrangler bundles at deploy time") only
   covers that service's own compilation; nothing rebuilds a workspace dependency's `dist/` on a
   fresh checkout, and Wrangler does not build workspace dependencies for you. Skipping this step
   fails `wrangler deploy` with esbuild resolution errors like
   `Could not resolve "@internal/worker-kit" ... ./dist/index.js` — the workspace dependency's
   `dist/` output has to exist before wrangler bundles, which is why the workflow's build step
   (see the `deploy-workers` job comment) targets each service's full upstream dependency graph
   (`turbo run build --filter="@service/<svc>..."`, the trailing `...` pulling in everything the
   service depends on) rather than the service alone.
3. **Deploy the three plain Workers**, in this order — `public-api` first since nothing depends
   on it, then `admin-api`, then `upload-api`:
   ```bash
   pnpm --filter @service/public-api exec wrangler deploy --env dev
   pnpm --filter @service/admin-api exec wrangler deploy --env dev
   pnpm --filter @service/upload-api exec wrangler deploy --env dev
   ```
4. **Smoke test** (against the `panote.dev` route; the `*.workers.dev` URL is off from
   the first dev deploy after 2026-10-08):
   - `GET /api/tours/x/stats` → `200` (no auth required; hits the `TourStats` Durable Object).
   - `admin-api` and `upload-api`'s own routes (e.g. `GET /api/admin/panos`,
     `POST /api/upload-url`) → `401` either way: a plain `curl` with no `Authorization` header at
     all 401s on the bearer-token check, before the issuer guard ever runs. A dummy bearer instead
     — `curl -H 'Authorization: Bearer x' ...` — now reaches real JWKS verification against
     `https://panote-dev.au.auth0.com/` (the issuer guard no longer fires for dev, since its
     `OAUTH_ISSUER` is a real tenant, not a placeholder) and 401s once that verification fails; see
     step 6 below for the genuine-token path (verified end-to-end on 2026-09-26). A
     path neither service declares → `404` (Hono's default for `admin-api`; `upload-api`'s handler
     checks method + pathname itself and returns 404 explicitly) — don't expect `401` from an
     unmatched path, only from a real route with no/invalid token.
5. **Queue cut-over**, only after steps 3-4 pass.

   **Pre-cut-over check, first:** confirm `pano-content-dev` still has 0 objects —
   ```bash
   pnpm --filter @service/admin-api exec wrangler r2 bucket info pano-content-dev
   ```
   **Caveat (found 2026-09-26):** `object_count` in this command's output lags badly — it showed
   `0` while the bucket in fact held 32 objects (written during the end-to-end test below). Don't
   rely on it to decide the count is actually 0; wrangler 4.120 can't list bucket objects without
   S3 credentials, so probe specific keys instead with
   `wrangler r2 object get <bucket>/<key> --remote` (against the `panos/` keys you expect might
   exist) before trusting an empty result from this check.

   A read-only probe of this same command on 2026-09-23 reported 0 objects: pano-viewer's live
   Workers share this bucket, but their upload route authenticates against the same placeholder
   Auth0 issuer as panote (no tenant exists for either), so it has always returned 401 and cannot
   have written any originals — no data exists under the old `encodeURIComponent` owner-encoding
   scheme (see `docs/decisions.md`) as of that probe. That is not guaranteed to still be true by
   the time you run this: anyone with account access could put an object manually in between. If
   the count isn't 0, **stop** — deploying `tiler-consumer` before checking would let it tile
   (and `deriveUploadTarget` derive a prefix from) an old-scheme key it was never designed to
   read — and inventory the bucket's `panos/` keys instead
   (`wrangler r2 bucket info` doesn't list keys; use `wrangler r2 object get`/a bucket listing
   tool). A key in the old percent-encoded owner scheme won't be visible to `admin-api`'s
   `GET /api/admin/panos`, which only ever lists base64url-encoded owner prefixes.

   Then the cut-over itself. `pano-uploads-dev` currently has one consumer slot, held by the old
   pano-viewer `pano-tiler-dev` Worker — a queue allows exactly one consumer, so the old one has
   to be removed before the new one can attach:
   ```bash
   pnpm --filter @service/tiler-consumer exec wrangler queues consumer remove pano-uploads-dev pano-tiler-dev
   pnpm --filter @service/tiler-consumer exec wrangler deploy --env dev
   pnpm --filter @service/tiler-consumer exec wrangler queues info pano-uploads-dev
   ```
   Messages published between the `remove` and the new deploy attaching persist in the queue
   (default retention) — nothing is dropped, delivery is just delayed until a consumer exists
   again.

   **Status: done, 2026-09-26 ~03:35 UTC.** `wrangler queues consumer remove pano-uploads-dev
   pano-tiler-dev` ran, then Deploy workflow run `36215364076` (`workflow_dispatch`, `dev`)
   redeployed all four Workers from `main` — all jobs green, and `pano-uploads-dev`'s consumer is
   now `worker:panote-tiler-consumer-dev`. The R2 notification rule (prefix `panos/`, suffix
   `/original` → `pano-uploads-dev`) needed no change.
6. **End-to-end test** — the Auth0 dev tenant now exists (`https://panote-dev.au.auth0.com/`,
   verified via its `.well-known/openid-configuration`), so `OAUTH_ISSUER` is no longer a
   placeholder in dev. This step still can't run to completion until step 5's queue cut-over has
   happened:
   ```bash
   pnpm --filter @service/admin-api exec wrangler r2 object put pano-content-dev/panos/<owner>/<pano-uuid>/original --file <test-image> --remote
   ```
   `--remote` is required — without it, `wrangler r2 object put` writes to local miniflare
   storage instead of the real `pano-content-dev` bucket, and the R2→queue notification never
   fires because nothing was actually written to R2. `<owner>` is `base64url(sub)` and
   `<pano-uuid>` is the pano id verbatim (only the owner segment is encoded — see
   `docs/decisions.md`), while watching `wrangler tail --env dev` on `tiler-consumer` — the
   R2→queue notification should fire, the consumer should pick up the message, and the container
   should tile it. Expect `tiles/<pano-uuid>/manifest.json` plus tiles under
   `tiles/<pano-uuid>/t1-<etag>/…` to appear — owner-free, not under `panos/`. The viewer must be
   given `baseUrl` `https://cdn.panote.dev/tiles/` to match (the `PanoViewer` default is `/tiles/`).
   If it doesn't, the consumer logs the reason on
   both failure paths — a non-`ok` container response (key, status, and the response body
   truncated to 500 chars) and a thrown/rejected `stub.fetch()` (key and error message) — so a
   dead-lettered job's cause should be visible in `wrangler tail` (or observability logs) rather
   than a bare retry-until-DLQ with no trace of why. Those two are both *transient* failures, and
   both are retried, 1, 2 and then 4 minutes apart (`retryDelaySeconds` in `consumer.ts`;
   `retry_delay: 60` in `wrangler.jsonc` covers a retry the code didn't schedule), until they
   either succeed or exhaust `max_retries` and dead-letter. A `422` from the container is not
   retried: the tiler refused the source itself (see "Sources the tiler refuses" below). A key that
   doesn't match `panos/<owner>/<panoId>/original`, with both segments restricted to their valid
   charset, is a different, permanent case: the consumer validates every key with
   `deriveUploadTarget` before it ever reaches the container, logs why the key is invalid, and
   acks it immediately — never retried, never dead-lettered, since retrying a key that can never
   succeed would only delay the inevitable and burn the retry budget for nothing.

   **Status: done, 2026-09-26 ~03:43-03:48 UTC.** Run against the real upload flow (an Auth0 M2M
   test token from the `panote-dev` tenant driving `admin-api`/`upload-api`, not the manual
   `wrangler r2 object put` above) rather than a synthetic key write, so it exercised
   `upload-api`'s presign path too: `GET /api/admin/panos` → `200` (first real JWKS success);
   `POST /api/upload-url` → presign; `PUT` of a 4096x2048 JPEG to the presigned URL → `200`; the
   R2→queue notification fired, the Tiler Durable Object picked it up, and the container tiled it;
   the manifest appeared on the CDN ~54s after the PUT (that includes the container's cold start;
   the Durable Object's own wall time was ~48s). The manifest's `version` was `t1-<etag>`; 30
   tiles (6 faces × (1 base + 4 level-1)), `maxLevel` 1, 512px webp, served from `cdn.panote.dev`
   with `cache-control: public, max-age=31536000, immutable`. The original itself, fetched via the
   CDN, returned `403` (the WAF rule). `DELETE /api/admin/panos/:panoId` → `204`; original,
   tombstone, manifest, and all tiles were gone at origin afterward; the list came back empty; a
   second `DELETE` of the same pano also returned `204`. See "Known limitations" below for what
   this run surfaced that still needs follow-up.

---

## Re-tiling

A new original uploaded to the same key re-tiles automatically — R2 fires the object-create
notification on overwrite the same as on first create, so nothing else has to be triggered by
hand.

After a change to the tiler's output itself (tile layout, encoding, pyramid shape), bump
`TILER_OUTPUT_VERSION` in `packages/tiler/src/version.ts`, deploy `tiler-consumer`, then re-tile
with `services/admin-api/scripts/retile.ts`. It doesn't touch the originals: it HEADs each one and
puts the same message on the upload queue (`pano-uploads-dev` for `pano-content-dev`,
`pano-uploads` for `pano-content`) that R2's object-create notification would have, with the
original's current size and ETag, so `tiler-consumer` handles it exactly like a fresh upload. It
runs like the other operator scripts (Node 24 straight from TypeScript, a built workspace, the R2
S3 credentials, and `--allow-bucket` for anything but a `-dev` bucket). It only lists what it
would queue unless you pass `--apply`, which also needs `CF_QUEUES_TOKEN`: a Cloudflare API token
with Queues edit permission on the account (it lists the queues to find the id, then sends batches
of 100).

```bash
export R2_ACCOUNT_ID=... R2_BUCKET=pano-content-dev R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=...
# What it would queue, sending nothing
node services/admin-api/scripts/retile.ts --all
node services/admin-api/scripts/retile.ts --pano <pano-uuid> --pano <pano-uuid>
# Queue them
CF_QUEUES_TOKEN=... node services/admin-api/scripts/retile.ts --all --apply
```

Finding the originals: the owner is only in the key, so the script lists every object under
`panos/` (also with `--pano`). A pano with a `deleting` tombstone is skipped, and so is a named pano
with no original. Every message starts a container: the queue's `max_concurrency` (5) paces them,
see "Tiling time and the queue limit" below for what that means for a large `--all`.

Re-tiling identical bytes **without** a version bump yields the same ETag, so the derived version
string (`t<TILER_OUTPUT_VERSION>-<etag>`) is unchanged too. The consumer reads the pano's manifest
before starting a container and acks the message without tiling when the manifest already names
that version (`alreadyTiled` in `services/tiler-consumer/src/consumer.ts`), so a duplicate delivery
or a re-upload of the same bytes costs one R2 read. A manifest it can't read means it tiles as
before. `retile.ts` is never skipped: its messages carry `force: true` (R2's never do), so a
re-tile of the same bytes runs and rewrites every key of that version dir, which is how to repair
a pano whose manifest is intact but whose tiles are missing.

### Sources the tiler refuses

`build()` (`packages/tiler/src/build.ts`) reads the original's header first and refuses, with a
`SourceRejectedError`, a file that:

- isn't JPEG, PNG or WebP by its bytes (whatever the upload's content-type said), or can't be read
  as an image at all;
- is over 150 MP (`MAX_INPUT_PIXELS`), also enforced by libvips through sharp's
  `limitInputPixels` on every `sharp()` that opens the source, with `failOn: 'warning'`;
- is more than 16:1 either way (`MAX_ASPECT_RATIO` in `packages/core/src/manifest.ts`). A 16:1
  strip is a full sweep with a 22.5° vertical field of view; real partial panoramas are well
  inside it. Wider strips are padded to 2:1 and, past the pixel cap, downscaled, so no accepted
  source makes more work than a real 150 MP 2:1 panorama (8,192 px faces).

The container answers `422` for these and the consumer acks the message once the
`unsupported` failure marker is written (or not needed, because the original changed); if the
marker write fails it retries, and the DLQ writes its own marker if retries run out. The original
stays; a new upload replaces it. Every other failure is a `500` and is retried.

The admin refuses the pixel and aspect cases before the upload starts
(`validateUploadImage` in `packages/web-kit/src/image-size.ts`, reading the header), with the same
`MAX_ASPECT_RATIO` from `@panote/core`, so only a client that skips it reaches the tiler's check.

### Old version dirs

Every successful re-tile leaves the previous version's tiles behind under `tiles/<panoId>/`. Once a
job's manifest swap is confirmed (its post-PUT HEAD still sees the ETag it tiled), it records every
other version dir it finds there at `tile-gc/<panoId>/<version>.json` (`{ v, originalKey,
tilerVersion, supersededAt }`). Records are overwritten on every swap, so their time and tiler
version always follow the latest one. A job that fails after it started uploading tiles records
its own, partial, version dir the same way, so a pano whose jobs only ever failed doesn't keep
them for good. `admin-api`'s 15-minute cron (`*/15 * * * *`, after the backup, in the same
invocation) deletes a recorded dir once the record is over 24 hours old, so a version goes 24
hours to 24 hours 15 minutes after it was superseded. Before deleting it checks, and keeps the dir if
any check fails:

- the manifest must be readable and name a different version (the version it names is never
  deleted; that record just goes);
- the pano's current original must not tile into that dir again (same ETag, same tiler version as
  the job that recorded it), since a job may be writing there; this holds with no manifest at all
  too, for a first upload whose job failed;
- nothing in the dir may have been written after the record (a re-upload of old bytes, or a tiler
  rollback, rewrote it); the record's time then moves to now.

A pano whose original is gone has been deleted; its record and dir just go.

**Limits.** The sweep shares the 15-minute invocation with the queued CDN purge retry and the
backup. The invocation makes at most `BACKUP_RUN_BUDGET` (900) R2 operations and purge requests,
the figure the backup was already sized to keep under the per-invocation subrequest limit: the
purge retry runs first and may spend 97 (CDN purge on delete), and the backup, the sweep and the
sweep's status share the other 803 (`runBackupThenTileGc` in `services/admin-api/src/tile-gc.ts`,
called with `totalOps: FIFTEEN_MINUTE_RUN_OPS`): the backup gets that less 2, and the sweep
whatever the backup run left. Once a day's backup set is complete a backup run costs 2
operations, so most runs give the sweep about 800. A record costs 3
operations to check, plus one list per 1,000 objects in the dir to look for newer writes and one
list and one delete per 1,000 to delete it: about 7 for a typical pano, 31 at most (a full
16,384 px pyramid, 8,192 objects). A run starts a record only with 31 operations left, and also
stops after acting on 200 records or looking at 500. That is roughly 110 typical records a run,
about 10,500 a day at 96 runs (the old daily run did 50). Each run starts at one of 16 points in
`tile-gc/`, moving on each quarter hour, and wraps round, so kept records listed early can't take
every run's budget. Kept ones are checked again on a later run. CPU is not a constraint (a record
is a few small JSON parses).

**Monitoring.** Each 15-minute run records `{ lastRunAt, lastOkAt }` at
`ops/cron/admin-api-tile-gc.json` (2 more R2 operations, taken out of the sweep's share). A run
is clean when the backup didn't throw and the sweep finished. The daily cron's `tile-gc` task
throws when the last clean run is over an hour old (four runs in a row) or none is recorded, so
the health check's `admin-api daily cron` check alerts on a failing sweep, as before. Right
after a deploy, a daily run before the first 15-minute run would report it once.

A record the sweep keeps because the current original tiles into that dir (an in-flight job, or
a pano whose jobs only failed) is rewritten with the time moved to now, so it is looked at again
a day later rather than on every run.

Nothing is purged: no manifest points at those URLs any more, and edge copies age out. Dirs
left over from before this existed are recorded the next time that pano re-tiles, so a
`retile.ts --all` after deploying this clears them too, a day later.

Records hold the owner-bearing original key, so deleting a pano (including through account
deletion) deletes `tile-gc/<panoId>/` along with `tiles/<panoId>/`. A tiler job that confirmed its
swap just before the delete can still write one afterwards; the sweep drops it about a day later
(the original is gone by then).

After a tiler rollback, a `retile.ts` job that starts writing into an old version dir while the
sweep is deleting it would leave a manifest pointing at a half-deleted dir. The window is seconds
per dir, but there is no lock between the two, and the sweep now runs every 15 minutes, so there is
no quiet hour to aim for. If a pano shows missing tiles after such a re-tile, re-tile it again with
`retile.ts --pano <pano-uuid> --apply`: its message is forced past the duplicate skip, and the job
rewrites every key of that version.

The grace period is for viewers: one that loaded the old manifest moments before the swap keeps
fetching that version's tiles for the rest of its session. Edge-cached tiles would survive a delete
anyway; uncached ones would 404.

## Link-preview image (og.jpg) and its backfill

Every tiling run also writes `tiles/<pano>/<version>/og.jpg` (1200x630, JPEG q80) and sets
`og: true` in the manifest. It's a normal-camera view rendered from the full-resolution source:
yaw 0, pitch 0, 100° horizontal fov, which is the first frame the viewer shows a scene with no
start view on a wide screen. The start view an owner picks in the editor isn't used: it isn't
known at tiling time. The website's share pages use og.jpg for `og:image` when the manifest has
the flag and fall back to `preview.webp` otherwise. The render adds about 0.7 s to a 50 MP job
(measured locally, out of ~110 s of build) and the files come out around 90-115 KB.

Panos tiled before this have no og.jpg. `services/tiler-consumer/src/backfill-og.ts` re-renders it
from their existing tiles (no original needed): for each pano under `tiles/` it reads the
manifest, skips it if it already has `og: true`, stitches the faces the view needs from the
smallest level that is sharp enough (level 2 for 512px tiles, 48 tile GETs), writes og.jpg into
the version dir, then re-reads the manifest and adds `og: true` only if it still names the same
version (a re-tile that landed meanwhile already has its own og.jpg). That manifest PUT carries
`If-Match` with the ETag it just read (R2 supports conditional `PutObject`), so a re-tile that
writes its manifest between the re-read and the PUT makes R2 answer 412 and the pano is reported
as skipped, never rolled back to its old tiles. It is safe to re-run.

It needs an R2 API token with Object Read & Write on the bucket (Dashboard → R2 → Manage API
tokens; the tiler's token is a write-only Worker secret, so make a new one, or reuse one you
kept), and it refuses any bucket not ending in `-dev` unless that bucket is also passed as
`--allow-bucket <name>`. Not run against any environment yet.

```bash
pnpm install --frozen-lockfile
pnpm exec turbo run build --filter="@service/tiler-consumer..."
export R2_ACCOUNT_ID=12e2809e05de8a2bf20b815fd394ec9a R2_BUCKET=pano-content-dev
export R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=...
# Reads manifests only and prints what it would do:
node services/tiler-consumer/dist/backfill-og.js --dry-run
# One pano first, then everything:
node services/tiler-consumer/dist/backfill-og.js --pano <pano-uuid>
node services/tiler-consumer/dist/backfill-og.js
```

It prints one line per pano (`rendered`, `would-render`, `skipped` or `failed` with the reason)
and exits 1 if any failed. A share page already scraped keeps its old card until the scraper
refetches it (Facebook's Sharing Debugger and LinkedIn's Post Inspector can force that).

## Tiling time and the queue limit

A queue consumer invocation has a 15-minute wall-time limit, and the consumer holds its
invocation open for the whole container `/tile` call. A dev run on a 50 MP (10000x5000) JPEG took
14 min 28 s: about 4-5 min of vips build on `standard-1` (0.5 vCPU) and 8-9 min of tile upload,
because `uploadDir` PUT its 510 tiles one at a time (~1 tile/s). Tile PUTs now run 16 at a time
(`UPLOAD_CONCURRENCY` in `services/tiler-consumer/src/r2io.ts`); the manifest is still written
last, only after every tile and the preview have succeeded.

With parallel upload, the same 10000x5000 image took 227 s on `standard-1`: download 1.1 s,
vips build 192.9 s, upload 29 s (511 files), manifest 0.8 s. The build was ~85% of the job, so the
container now runs on `standard-4` (4 vCPU, 12 GiB memory, 20 GB disk), the largest predefined
type; a custom `instance_type` caps at the same 4 vCPU and 12 GiB. The container sets libvips to
4 threads at startup (`VIPS_THREADS` in `services/tiler-consumer/src/container.ts`). It has to:
sharp drops libvips to 1 thread on glibc without jemalloc, which is this image, so neither the
default nor a `VIPS_CONCURRENCY` env var would use the extra cores. Change both together.

Not every part of the build scales with cores: the equirect-to-cube remap (`renderFace`) is plain
JS on one thread, and tiles are encoded one at a time. Expect a large speedup over 0.5 vCPU, not
8x. The new baseline has not been measured yet; check the `tiler pano=<panoId> build done in ...`
line after the first large upload and update this section.

Cost: CPU is billed per vCPU-second of active use, so the same build work costs roughly the same
on 4 vCPU as on 0.5. Memory and disk are billed on what is provisioned, for as long as the
container runs, including the 1 minute `sleepAfter` idle tail in `src/consumer.ts`. 12 GiB is 3x
`standard-1`'s 4 GiB, so the memory part of a job costs more unless the job gets much shorter.
At $0.0000025 per GiB-second that is fractions of a cent per job. With `max_instances: 5`, the
worst case is 20 vCPU and 60 GiB running at once, far below the account's concurrent limits
(1,500 vCPU, 6 TiB).

Both sides log phase timings with the panoId only: the consumer logs `tile job start`/`tile job
end`, and the container logs download, build, upload (file count and duration), manifest, and
total time as `tiler pano=<panoId> ...` lines. If a job still gets close to 15 minutes, the
remaining follow-up is to decouple the queue invocation from tiling (ack once the container
accepts the job and report completion separately).

## Deleted panos

`admin-api`'s `DELETE /api/admin/panos/:panoId` always returns 204 and is idempotent. Without proof
of ownership (no original, no tombstone under the caller's own prefix) it only cleans up the
caller's own owner-scoped prefix (`panos/<owner>/<panoId>/`) and never touches `tiles/<panoId>/` —
a config-only pano (one whose original was never actually uploaded) still deletes and stays
deleted, and a repeat DELETE of an already-deleted pano is a no-op 204 rather than a 404. With
proof, `deletePano` (`services/admin-api/src/delete-pano.ts`) writes a tombstone key first
(`panos/<owner>/<panoId>/deleting`, skipped if one is already there), moves the original to the
trash ("Trash for deleted originals"; a takedown deletes it outright), sweeps
`tiles/<panoId>/` once, then deletes the rest of the owner prefix, tombstone included, in one
prefix delete. Every step before that final delete is safe to redo, so an
interrupted DELETE (a client disconnect, or a step that throws) is recovered by **re-running
DELETE**: the leftover tombstone means the pano still lists under `GET /api/admin/panos` (its
prefix is still non-empty), and DELETE resumes from wherever it stopped.

Tiles are written `public, max-age=31536000, immutable`, so both Cloudflare's edge cache and any
browser that already fetched one can keep serving it for up to a year after delete — anyone who
already has a tile URL keeps access to it until a cache purge, full stop. In practice a deleted
pano's tile URLs can't be *discovered* once the manifest's ~30s cache expires, since a client would
need a stale manifest it already had cached to read them from. A Cloudflare cache purge by prefix
or URL is the only way to revoke access sooner; `admin-api` now does that on delete, best-effort
(see "CDN purge on delete" above). A browser's own cached copy is out of its reach.

One sweep of `tiles/<panoId>/` is enough to catch every tile a still-in-flight tiler job writes,
because every tile/manifest write precedes that job's own last HEAD of the original
(`services/tiler-consumer/src/container.ts`). If that HEAD lands after `deletePano` has already
deleted the original, it 404s and the job deletes its own tile keys (and the manifest, if it got
that far) instead of writing anything more; if it lands before, all of that job's writes already
precede the delete of the original, and so `deletePano`'s sweep, and R2's strong read-after-write/list-after-write
consistency (<https://developers.cloudflare.com/r2/reference/consistency/>: an operation's effect
"is observed globally, immediately, by all clients") guarantees the sweep sees it. The tiler also
re-HEADs the original once more right after a successful manifest PUT: a 404 there deletes the
manifest and every tile key that job just wrote (`packages/worker-kit/src/r2-s3.ts`'s
`deleteObject`); an ETag that instead comes back *different* (a newer original landed and was tiled
after this job's pre-swap check, so this job's manifest PUT may have overwritten the newer one's)
makes the job throw and retry instead of cleaning up, so the queue redelivers it, it re-GETs the
now-current original, and rewrites the correct manifest — closing what used to be a window where a
superseded job's stale manifest could survive undetected. Any other non-ok status throws so the
queue retries instead of treating a transient error as gone. If a cleanup step itself can't delete
one of its own keys, the job throws again — but since the original is already confirmed gone by
then, a queue retry just fails immediately at `r2.get(key)` (404) rather than re-attempting the
cleanup, so the job dead-letters with the failed keys logged (`deleteKeys`). Recovery from a
dead-lettered cleanup is a manual `wrangler r2 object delete pano-content-dev/<key> --remote` per
key logged in that failure — this applies only to a dead-lettered tiler cleanup, not to an
interrupted DELETE, which is recovered by re-running DELETE instead.

One edge case neither side catches: a tile PUT whose `fetch` call itself threw (a timeout, a
dropped connection) but that R2 committed anyway. The job only knows about the failed `fetch`, not
that the write landed, so it never cleans up after it. A re-run (or still in-flight) DELETE's sweep
still catches it like any other late write; only if it happens after DELETE has already completed
and removed the tombstone does a later DELETE take the no-proof path and skip `tiles/<panoId>/`
entirely, leaving that one narrow case to the same manual per-key delete.

A presigned upload URL stays valid for up to 120 seconds after `upload-api` issues it, and a
new-pano URL that hasn't been used yet can still be used within that window to re-create a deleted
pano's original — which re-tiles a pano that now has no `config.json`. That isn't a leak of
anything new, and the pano can simply be deleted again. A URL already used can't: it is
create-only (`If-None-Match: *`, see "Single-use upload URLs"). The replace-image path
(`POST /api/upload-url` with `panoId`) is pinned to the original's ETag (`If-Match`), so once a
DELETE has removed that original, the URL gets `412` and can't recreate it. It stays confined to
the caller's own owner-scoped prefix either way.

---

## Account deletion

An owner deletes their own account from the admin app's account menu ("Delete account", on the
dashboard and in the editor, behind a typed confirmation). That calls `DELETE /api/admin/account`
on `admin-api` with the body `{"confirm":"delete my account"}` (`ACCOUNT_DELETE_CONFIRMATION` in
`@internal/contracts`; any other body is a `400` and touches nothing). The code is
`services/admin-api/src/delete-account.ts`.

**A recent sign-in (step-up).** Tokens live in localStorage, so a token alone (stolen through
some future XSS, or left in a shared browser) must not be able to wipe an account. The route also
wants the access token's sign-in time, the custom claim `https://panote.io/auth_time` that the
Auth0 post-login Action adds (see "Account linking"; `AUTH_TIME_CLAIM` in `contracts/src/jwt.ts`),
to be at most `RECENT_AUTH_MAX_AGE_SECONDS` (600 s) old, with a minute of clock skew allowed the
other way. Otherwise, or when the token doesn't carry the claim, it answers
`403 {"error":"reauthentication required"}` and touches nothing (the phrase is checked first). The
Action leaves the claim off tokens minted by a refresh-token exchange, so a stolen refresh token
can't mint a "just signed in" token either.

The admin app handles that `403` by asking the owner to sign in again: a sign-in dialog ("Sign in
again to delete your account") whose buttons call `loginWithRedirect` with `prompt=login` and
`max_age=600`, so Auth0 makes them actually sign in even with a live Auth0 session. They come back
to the same page with `?delete-account=reauthenticated`, the delete dialog opens again, and they
type the phrase once more. The sign-in sends the owner's email as `login_hint`, and the dialog
keeps the sub that asked in `sessionStorage` across the redirect: if they come back signed in as
a different account (or the tab lost that record), it refuses and deletes nothing, so a re-auth
with the wrong Google account can't delete that other account. If the server still refuses right after that sign-in (the Action isn't
deployed, so no token has the claim), the dialog says it couldn't confirm the sign-in and names
the contact address instead of looping. With Google, `prompt=login` makes Auth0 itself
re-authenticate; Google may sign the person straight back in if their Google session is live,
which still proves they hold that Google session, not just a Panote token.

`REQUIRE_RECENT_AUTH` (an `admin-api` var, `"true"` in both envs in `wrangler.jsonc`) turns the
check off when it is exactly `"false"`. It is the escape hatch for an env whose tenant doesn't add
the claim yet; while it is off, account delete is back to the typed phrase only.

**Rollout order** (once per tenant, dev and later production). Merging this auto-deploys
`admin-api` to dev with the check on, so until the Action change below is live on the dev
tenant, Delete account on dev fails closed with the "couldn't confirm your sign-in" message.
Nothing else is affected.

1. Paste the new `packages/auth0-actions/src/link-accounts.cjs` into the "Link accounts by
   verified email" Action and Deploy (see "Account linking"; it needs no new secret). It now adds
   the sign-in time and the linked subs to every access token, whether or not linking is set up.
2. Check it: sign out and in on dev, then Delete account on a throwaway account: it should go
   straight through, or, if the last sign-in was more than 10 minutes ago, ask once for a fresh
   sign-in and then go through.
3. Production: do step 1 on the production tenant **before** the first production deploy that
   contains this, or deploy with `REQUIRE_RECENT_AUTH` set to `"false"` under `env.production` and
   set it back once the Action is live. If both are missed, nothing is deleted by mistake: Delete
   account just refuses until the Action is deployed.

**Linked identities.** The marker also records the token's linked subs (`linkedSubs`, the
`https://panote.io/linked_subs` claim, at most 10): every identity linked into this Auth0 user, as
the user id it had before the link. Their `tours/`, `panos/` and `upload-log/` prefixes are deleted
exactly like the account's own, by the route and by the daily sweep until the delete completes,
so data made under a sign-in before it was linked (see "Account linking", **Known gap**) goes with
the account. After `completedAt` the sweep's late-data pass covers the account's own sub only:
data under a linked sub from then on can only belong to a new, separate user with that provider
id (the Auth0 user was removed and they signed up again, or the operator unlinked it), which the
marker doesn't block, so it isn't deleted. A retry whose token names more linked subs adds them
to the marker, up to `MARKER_MAX_LINKED_SUBS` (40) in all, so the marker always parses; any past
that are left out and logged (`more linked subs than a marker holds`). If the delete had completed, that reopens it: `completedAt` comes off and the subs
already done move to `completedLinkedSubs`, so the reopened delete (the route and the sweep)
covers the account's own sub and the new subs only, never a sub an earlier run finished (it may
have been unlinked since and belong to someone else). The next completion stamps `completedAt`
again, so the 30-day marker retention runs from the reopen's completion rather than the first
one. That is fine: the account only stays read-only (and swept) that much longer, and the Auth0
removal due date `--list` shows runs from `requestedAt`, which a reopen keeps, so it doesn't move.
Otherwise a retry on a completed delete deletes only the subs
its own token names. `completedAt` is stamped only when every pending sub on the marker was among
what that run deleted, so a linked sub added while a run was going waits for the next one. The
operator's `delete-account.ts --sub` marks the primary sub only; to cover a linked sub there, mark that sub too.

**Order, and why a retry finishes the job.**

1. A marker, `accounts/<owner>/deletion.json` (`{ v, sub, requestedAt, completedAt?, linkedSubs?, completedLinkedSubs? }`), is
   written create-only. From then on every `admin-api` write route (`POST`/`PUT`/`PATCH`/`DELETE`
   under `/api/admin/*`, except the account route itself and the operator routes) and `upload-api`'s
   `POST /api/upload-url` answer `410 {"error":"account deleted"}` (one R2 HEAD each, failing
   closed), so nothing can recreate what the delete is removing. Reads still answer, with whatever
   is left. `accounts/` is owner-scoped like `panos/` and `tours/`: the CDN's WAF rule (above)
   only lets `tiles/`, `pub/` and `slugs/` through.
2. Each tour, in the same shape as tour delete: the redirect aliases still listed in its
   `publish.json` (only those still pointing at this tour), an unpublish through its
   `TourPublisher` (live slug, `pub/tours/<id>.json`, `publish.json`), its `TourStats` counters
   (views, likes and the like-dedupe keys; a `DELETE` to the Durable Object through the `STATS`
   binding), then `tour.json`, then aliases and unpublish **again** (a publish already queued on
   the `TourPublisher` behind the first unpublish still saw `tour.json` and republished; any later
   one finds no `tour.json` and takes itself down in its own commit), the counters again, and last
   whatever is left under `tours/<owner>/<tourId>/`. Everything that must not be skipped happens
   while `tour.json` still exists, so the tour still lists for a retry. Tours go before panos, so a
   live tour comes down before its images do. Tour ids share pano ids' generator and validator
   (`crypto.randomUUID()`, `PANO_PATTERN`); an id that fails it can't have been published, so only
   its counters and prefix are deleted.
3. Each pano: the same `deletePano` as a single pano delete (tombstone, original moved to the
   trash unless the owner is disabled, one sweep of
   `tiles/<panoId>/` and of its superseded-version records under `tile-gc/<panoId>/`, which name the
   owner's original key, then the owner prefix). No reference or recent-upload checks: everything
   goes. A record a tiler job writes in the moment after that is dropped by the tile sweep 24-48
   hours later (see "Old version dirs").
   Then `upload-log/<owner>/`, upload-api's log of the upload URLs it issued (Owner quotas).
4. `completedAt` is stamped on the marker, and the response is `200 {"status":"deleted"}`.

If any step throws, the route still answers `202 {"status":"pending"}`: the account is already
read-only, and the daily sweep finishes it. Either way the admin app signs the owner out (and if
sign-out itself fails, sends them to the website rather than offering a retry). CDN purges
(tiles prefixes, bundles, slugs) are batched as for tour delete (see "CDN purge on delete"),
including for a partial run.

**Daily sweep.** The existing `17 3 * * *` Cron Trigger also works through every marker:

- Interrupted deletes (no `completedAt`) first, oldest request first, then finished ones.
- A finished account costs one `LIST` (`limit: 1`) per owner prefix; only if something turned up
  there (a presigned upload issued before the marker, valid for 120s) does it run the full delete
  again.
- One run deletes at most `SWEEP_ITEM_BUDGET` (400) tours plus panos, and one account at most
  `SWEEP_ACCOUNT_ITEM_BUDGET` (100) of them, so one huge account can't starve the rest; what's
  left waits for the next day.
- `completedAt` keeps its first value. From 30 days after it (`ACCOUNT_MARKER_DAYS`), the sweep
  deletes the marker, but only after a run that left the account empty: if deleting a leftover
  fails, the marker stays and the account stays read-only. After that the same Auth0 user could sign
  in again to an empty account, so the Auth0 user has to be gone by then (below).
- A marker that doesn't parse, or whose `sub` doesn't match its own key, is logged and skipped;
  one account failing doesn't stop the others. Only `deletion.json` keys count as markers: the
  operator's `disabled.json` (see "Takedown") lives under the same `accounts/<owner>/` and is left
  alone, so a disabled owner who deletes their account stays disabled.

Every log line about this starts with `[account-deletion]` and never carries a sub or a key (the
owner segment of a key is reversible). The ones to watch in the Worker's observability logs:
`account deleted: remove its Auth0 user within 30 days` when a deletion completes, a daily
`N deleted account(s) in their 30-day window: check each Auth0 user is removed` while any are,
and `delete interrupted` / `sweep failed for one account` if something is stuck.

**The `STATS` binding** points at the class `public-api` declares (`script_name` in
`services/admin-api/wrangler.jsonc`), so `public-api` must exist in an environment before
`admin-api` deploys there. Dev already has it. On the first production deploy the Deploy
workflow's matrix runs both at once: if `admin-api` fails on the binding, rerun it once
`public-api` is up. Nothing public reaches the reset: `public-api`'s routes never forward a
`DELETE` to the Durable Object, and `admin-api` only clears the tours listed under the caller's
own prefix. In tests, `services/admin-api/vitest.config.ts` stands in a small Worker with that
name.

**What it doesn't remove.**

- **The Auth0 user.** Nothing here calls the Auth0 Management API. Until that's wired up, the
  operator removes it by hand within 30 days of the request (weekly check below); the admin app
  and the privacy page promise exactly that. The marker's `sub` is the primary user's (see
  "Account linking"): deleting that user in the dashboard deletes its linked identities with it,
  so one delete removes every way that person signed in. A secondary that was never linked (an
  unverified email, an Apple relay address) is a separate user with its own data and is not
  touched.
- **Likes this user gave on other people's tours.** A signed-in like stores a keyed hash of the
  sub (`likedh:<HMAC>`, see "Likes") in that tour's `TourStats`, and there's no index from a user
  to the tours they liked. The hash can't be tied back to the sub without `LIKER_HASH_KEY`. A
  like given before the hash was stored raw (`liked:<sub>`) until that tour's `TourStats` next
  gets a request, which rewrites it. The privacy page says likes stay.
- **Analytics Engine events** for the deleted tours. They're keyed by tourId, hold nothing about
  the owner, and age out with AE's three-month retention (see Insights).
- **Redirect aliases a tour dropped before every alias was tracked** (`MAX_ALIASES` was 20 and
  older ones went untracked). They stop being followed once the tour's live slug is gone and the
  daily alias sweep removes them when they expire.
- **Copies already in a browser cache**, and edge copies if the purge isn't configured (see
  "Deleted panos").
- **The nightly backup's copies** of the account's tours, configs and markers (see "Backups"),
  for up to 31 days: the delete never touches `backup/`, and each dated set goes when it ages
  out. The privacy policy states this.
- **The originals, in `trash/`** for up to 31 days ("Trash for deleted originals"), unless the
  operator had disabled the owner (a takedown), when they are deleted for real. The privacy policy
  states this too.

### Operator: the account-delete script

`services/admin-api/scripts/delete-account.ts` reads and writes the markers over the R2 S3 API,
with the same credentials as the og.jpg backfill (an R2 API token with Object Read & Write on the
bucket). It runs straight from TypeScript on Node 24 and needs a built workspace (`pnpm build`)
for its `@internal/*` imports. Like the backfill, anything but a `-dev` bucket has to be named
twice with `--allow-bucket`. It never deletes anything itself, so running it twice is harmless.

```bash
export R2_ACCOUNT_ID=... R2_BUCKET=pano-content-dev R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=...
# Every marker: sub, requestedAt, completedAt, and the date its Auth0 user must be gone by
node services/admin-api/scripts/delete-account.ts --list
# One account, by its Auth0 user id (Auth0 dashboard: User Management → Users), e.g.
SUB='google-oauth2|1234'
node services/admin-api/scripts/delete-account.ts --sub "$SUB" --dry-run   # no request at all
node services/admin-api/scripts/delete-account.ts --sub "$SUB"             # mark it
node services/admin-api/scripts/delete-account.ts --sub "$SUB" --status    # where it is
```

Marking writes the same marker as the owner's route, create-only (`If-None-Match: *`), so a
marker that already exists, the owner's own included, is left as it is. A `--sub` with leading or
trailing whitespace is refused. The next daily sweep (03:17 UTC) then does the whole deletion.

**Weekly check (Auth0 removal).** Once a week, for each environment:

1. Run `--list`.
2. For every row, make sure that Auth0 user is deleted (Auth0 dashboard: User Management → Users →
   search the sub → Delete; a user that's already gone is done). Do it before `auth0RemovalDueBy`.
3. Rows disappear on their own 30 days after `completedAt`. A row with `completedAt` `-` for more
   than a day is a stuck delete: look for `[account-deletion]` errors in `admin-api`'s logs.

For a deletion requested by email: `--sub` to mark it, `--status` the next day, then delete the
Auth0 user as above and reply to the request.


### Operator: account storage

There is no admin screen listing accounts. `services/admin-api/scripts/account-storage.ts` lists
every account the bucket has anything for, largest first, with its tours (`tour.json`s), panos
(directories under `panos/<owner>/` without a delete tombstone, as the quota counts them), the
bytes of their originals (the figure `MAX_BYTES_PER_OWNER` caps), the bytes of its deleted
originals in `trash/` (not counted toward the quota), and whether it is marked for deletion or
disabled. `--tiles` adds each account's tile bytes and its **untiled** panos (an original with no
`tiles/<panoId>/manifest.json`: a failed or lost tiling job, or one still running; retry them
with `retile.ts --pano`), and a line for tile dirs that belong to no pano (left by a delete that
raced a tiling job, "Deleted panos"), at the cost of one more listing, of all of `tiles/`, which is
most of the bucket's keys. It is **read-only**: it only lists keys over the R2 S3 API, never reads
or writes an object, so it has no dry run because it needs none, and an R2 API token with Object
Read is enough. Same `R2_*` variables and `--allow-bucket` rule as the other scripts.

```bash
export R2_ACCOUNT_ID=... R2_BUCKET=pano-content-dev R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=...
cd services/admin-api
node scripts/account-storage.ts             # a table, with a totals row
node scripts/account-storage.ts --top 20    # the 20 largest
node scripts/account-storage.ts --json --tiles > storage.json
```

The account column is the Auth0 user id, decoded from the key's owner segment, so treat the
output like the case log: keep it private. Listing costs one Class A operation per 1,000 keys.

Bulk re-tiling already has a script: `retile.ts` ("Re-tiling").

---

## Tour editors

An owner can invite other people to edit a tour (`services/admin-api/src/members.ts`,
`packages/contracts/src/members.ts`; the reasoning is in `docs/decisions.md`, "Tour editors").
Everything stays in the owner's account: an editor works on the owner's `tours/<owner>/` and
`panos/<owner>/` keys, and nothing is copied into the editor's own prefix.

- **Who's who.** `tours/<owner>/<tourId>/members.json` lists the editors and pending invites (at
  most 10 together). An editor's access is checked on every request: the tour's owner pointer
  (`tour-owners/<tourId>.json`) names the owner, and that owner's `members.json` must list the
  caller. The owner's first invite makes sure the pointer exists, so older tours need no backfill.
  `memberships/<editor>/<tourId>.json` is each editor's index for their dashboard ("Shared with
  you", `GET /api/admin/shared-tours`); it is a hint, re-checked on every read, healed when the
  editor opens the tour, and not backed up.
- **What an editor can do.** Open and Save the tour (Save republishes a shared tour as the
  owner's does), edit its scenes' configs, upload panoramas and a floor plan into it (with
  `tourId` on `POST /api/upload-url`), and see its insights and its People list. Not: change the
  share link, visibility or Stop sharing, invite or remove others (they can leave), delete the
  tour, or delete the owner's panoramas. Pano routes take `?tourId=` for an editor and reach only
  that tour's scenes, or a panorama an editor uploaded for that tour and Save hasn't added yet.
- **Which panoramas an editor can add.** An editor's tour Save may keep or drop the tour's
  scenes, and add only panoramas an editor uploaded for this tour: upload-api writes
  `uploaded-for/<owner>/<panoId>.json` (`{ v, tourId, sub }`) before it hands an editor an upload
  URL. Anything else gets a 403 (`pano not found`), so knowing the id of the owner's other
  panoramas (they are public in shared tours) never reaches them through a tour someone edits.
  The records go with the owner's account; a deleted panorama's record is left, and is harmless.
- **Invites.** `POST /api/admin/tours/<tourId>/invites` with `{ "email" }` returns a link token
  (`<tourId>.<secret>`) once; only its SHA-256 is stored. Panote sends no email: the owner copies
  the link. It works for 7 days, once, and only for someone signed in with that address as their
  verified email claim (`https://panote.io/email`, "Account linking"). Inviting the same address
  again replaces the link; the owner can revoke it.
- **In the admin app.** The editor's People button (`/app/t/<tourId>/people`) lists the owner,
  editors and pending invites; the owner invites, cancels and removes there, and an editor can
  leave (`GET …/members` marks the caller's own entry with `you`). An invite link is
  `/app/invite#<token>`: the token stays in the fragment, so it never reaches a server log or a
  Referer. Tours shared with someone show on their dashboard under "Shared with you". For an
  editor the editor hides Share and Add from library, and every pano call and upload carries the
  tour (`?tourId=`, or `tourId` in the upload body).
- **Limits.** Uploads by an editor count against the owner's panorama and storage quotas, and
  against both people's daily upload limit. One person can edit at most 50 shared tours.
- **Deletion and takedown.** Deleting a tour (owner, operator or account deletion) removes its
  editors' index entries; deleting an editor's account takes them off every tour they edit, and
  what they uploaded stays with the owner. While the owner's account is marked for deletion its
  editors get a 404, and while the operator has the owner disabled their editors can't write.
- **Changing owner.** The owner can offer the tour to one of its editors
  (`POST /api/admin/tours/<tourId>/transfer` with `{ "memberId" }`; needs a recent sign-in, like
  account deletion). The offer is kept in `members.json`, lasts 7 days, and is withdrawn by the
  owner, declined by the editor (`DELETE …/transfer`), or dropped when that editor is removed.
  The editor accepts with `POST …/transfer/accept`, which runs in the tour's `TourPublisher`
  Durable Object: it checks the new owner's limits (tours, panoramas, storage; admin-api's
  `MAX_PANOS_PER_OWNER` and `MAX_BYTES_PER_OWNER` must equal upload-api's), writes
  `tour-transfers/<tourId>.json` (who to whom, and each pano's id in the new account), then copies
  the tour and its panoramas into the new owner's prefix, rewrites the owner pointer and deletes
  the old keys. A panorama the old owner's other tours still use is copied under a new id and
  tiled again from its original; any other one moves with its tiles. The old owner stays on as an
  editor. While the record exists every write to the tour (admin-api and upload-api, tour
  delete, share link, visibility and Stop sharing) gets a 409 (`tour is changing owner`). A
  large tour can outrun one request: accept then answers 202 (`finishing`), accepting again
  carries on, and the daily cron finishes any left behind.
- **Panoramas the old owner keeps using.** `lent-panos/<old owner>/<tourId>.json` lists the
  old owner's ids of every panorama the tour used. While the transfer runs, and afterwards while
  the tour's live bundle still names them (it keeps the old ids of copied panoramas until the
  new owner publishes again, and a copy can be published once its tiles are ready), they count
  as in use for the old owner: deleting the panorama, another tour or the account doesn't take
  their tiles. Account deletion still deletes the original and config but leaves those tiles,
  which then stay until an operator removes them. The daily cron drops records that protect
  nothing. A panorama the old owner puts in another tour while it is moving becomes a copy
  instead.

## Backups

There is one bucket per environment and R2 keeps no versions, so a bug or a bad script that
deletes a prefix would otherwise be final. `admin-api` copies the small JSON documents that
define user content to a private, dated prefix in the **same** bucket every day
(`services/admin-api/src/backup.ts`).

**What's in a set.** `BACKUP_SOURCES` in `@internal/contracts` (`keys.ts`): every `tours/<owner>/<tourId>/*.json`
(`tour.json`, `publish.json`, `sharing-stopped.json`), each pano's `panos/<owner>/<panoId>/config.json`,
`pub/**.json`, `slugs/*.json`, `tour-owners/*.json`, `explore/{index,tours,hidden}/*.json`, the
account markers `accounts/<owner>/{deletion,disabled}.json`, and the tours' floor-plan images
`pub/plans/<tourId>/<planId>.{webp,jpg,png}` (at most 4 MiB each, `MAX_PLAN_BYTES`). Not in it:
originals (large; a deleted one waits 30 days in `trash/` instead, see "Trash for deleted
originals" below), tiles and manifests (rebuilt from the original by a re-tile, "Re-tiling"
above), and the derived or operational prefixes `tile-gc/`, `upload-log/`, `quarantine/`,
`trash/`, `ops/`, `slug-holds/` and the account-age record `accounts/<owner>/since.json`
(worked out again from the originals if lost). Each copy keeps the object's content type, cache control
and custom metadata (titles, visibility, an alias's expiry), since the app reads those.

**Layout.** `backup/<YYYY-MM-DD>/<original key>`, with `backup/<YYYY-MM-DD>/complete.json`
(`{ v, date, startedAt, completedAt, objects, bytes, failed, skipped, runs }`) once the set is
whole, and `backup/progress.json` while one is being written. A set without `complete.json` is
partial. `backup/` is private: the CDN's WAF rule only lets `/tiles/`, `/pub/` and `/slugs/`
through (fail-closed), and the post-provision check lists `backup/x`. Nothing but the backup run
and the operator restore route reads or writes it: account deletion, takedown, the tour and pano
deletes and the daily sweeps only ever delete their own prefixes (a test runs all of them over a
backed-up account and checks every copy is still there). So **a backup holds deleted data**,
including a deleted account's, until its set ages out, at most 31 days.

**Schedule and retention.** Its own Cron Trigger, `*/15 * * * *` (`BACKUP_CRON`, in both env
blocks of `wrangler.jsonc` beside the daily `17 3 * * *`), so it gets an invocation, and a
subrequest budget, of its own. The first run after 00:00 UTC starts that day's set. Each run makes
at most `BACKUP_RUN_BUDGET` (900) R2 operations less the 97 the queued CDN purge retry may
spend first and the tile sweep's status's 2 (so 801; the sweep gets what it leaves), records how far it got in `progress.json`, and
the next run carries on from there; a set that runs past midnight is finished before the next
day's starts, so sets are never left half-done by the calendar. Once a day's set is complete, a
run costs one GET and one HEAD. A run saves its progress every 100 objects and after every
listing page, so one that dies part way loses little, and it holds a lease (`lockedUntil` in
`progress.json`, taken with a conditional PUT) while it writes: a run that finds a live lease does
nothing, and a lease (20 minutes) outlasts any run, as Cloudflare stops a Cron Trigger invocation
after 15 minutes.
The run that completes a set deletes every set more than `BACKUP_RETENTION_DAYS` (30) days older
than today, but never the newest **good** set (complete, no failed copy, at least one object),
however old, and nothing at all if there is no good set; a prune cut short by the budget finishes
after the next set. A copy that fails is counted (`failed`), left
out and tried again in the next day's set; an object over 8 MiB is counted as `skipped` and never
copied (nothing the app writes is close: plan images, the largest objects in a set, are capped at
4 MiB by `upload-api`). A copy is read whole into memory, 10 at a time, so a batch of plan images
is at most 40 MB.

**Logs** (`admin-api` observability), each starting `[backup]`, never with a key (the owner segment
is reversible): `set <date>: N object(s) copied this run, M so far; the next run carries on` while
a set is being written, `set <date> complete: …` when it's whole (an error, not a warning, if any
object failed or was skipped), and `set <date> is still being written; the backup is falling
behind` when a set is more than a day old: that is the signal for the scaling step below.

**Limits and when to move it.** A copy is a GET and a PUT (2 operations); listing is one per
1,000 keys under a source prefix (all of `panos/` is listed, originals included, to find the
configs); the lease is one per run, and a progress write one per 100 objects or page. So a run
copies about 400 objects, and at 96 runs a day the backup keeps up with roughly **38,000 backed-up objects** in all. One account at today's
caps (500 panos, 200 tours, each published with a slug and up to 5 aliases, on Explore) is about
500 configs + 400 tour records + 2,000 public keys, about 3,000 objects or 6,000 operations: 7
runs. A typical account is a few dozen objects. Past ~40,000 objects (the "falling behind" log, or
a `complete.json` whose `runs` passes 90), move the copy off the cron: have the cron enqueue one
message per source page on a Queue, or start a Workflow with a step per page, so each batch gets
its own invocation and budget. Raising `BACKUP_RUN_BUDGET` is the stopgap, as long as it stays
under the Workers per-invocation subrequest limit for the account's plan (check the current
figure in Cloudflare's Workers limits docs first); CPU is not the constraint (copying JSON is
milliseconds).

**Cost.** Per set, one Class A operation (the PUT) and one Class B (the GET) per object, plus
the listing; storage is 31 copies of the JSON and of the plan images. A tour has one live plan
image (a few hundred KB to 4 MiB), so plans are most of a set's bytes: 1,000 tours with plans is
roughly 1 to 4 GB per set, 31 to 120 GB kept. That is the figure to watch on the R2 bill; the
operation count barely moves (one object per tour). Pre-launch that is well inside R2's free tier.
At 40,000 objects it is about 1.2 million Class A operations a month (about $1 past the free
million, shared with everything else) and 31 × the JSON's total size in storage.

### Restoring

`services/admin-api/scripts/restore-backup.ts` restores one tour, one owner, or everything, from
a chosen day's set. It plans over the R2 S3 API (the same `R2_*` variables as the other operator
scripts) and writes through `admin-api`'s operator route `POST /api/admin/operator/restore`
(`OPERATOR_TOKEN`, the takedown route's secret), because only the native binding puts an object's
custom metadata back exactly. Like the others it is a dry run unless `--apply`, and a bucket that
doesn't end in `-dev` has to be named again with `--allow-bucket`.

```bash
export R2_ACCOUNT_ID=... R2_BUCKET=pano-content-dev R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=...
export OPERATOR_TOKEN=...   # only for --apply
cd services/admin-api
# The sets there are, and whether each is complete
node scripts/restore-backup.ts --list
# One tour (its owner is found in the set; --sub <auth0 user id> to name it)
node scripts/restore-backup.ts --date 2026-10-21 --tour <tourId>
node scripts/restore-backup.ts --date 2026-10-21 --tour <tourId> --apply
# Everything one owner had, by Auth0 user id
node scripts/restore-backup.ts --date 2026-10-21 --sub 'google-oauth2|1234' --apply
# The whole bucket: after an incident, from the last set before it
node scripts/restore-backup.ts --date 2026-10-21 --all --apply
```

- A tour is its `tours/<owner>/<tourId>/` records, the configs of the panos its tour and bundle
  show, its bundle, its owner pointer, its Explore pointer, entry and hidden marker, every
  floor-plan image the set holds under `pub/plans/<tourId>/`, and the share links its backed-up
  publish record names that point at it. An owner is every tour and config
  under their prefix, with those tours' public keys.
- **Create-only by default**: a key that exists now is left as it is and only missing keys come
  back. `--overwrite` replaces existing keys with the backed-up copy too (an owner's edits since
  that day are lost). The dry run lists every key as `restore`, `replace` or `keep (exists)`.
- **It brings back whatever was deleted after that date**, deliberate deletes and takedowns
  included, so use the narrowest scope that covers the damage, and read the dry run of an
  `--all` before applying it.
- It refuses an owner whose account is marked for deletion now (the daily sweep would delete the
  restore again); `--all` leaves such owners out, with their tours' public keys. The route checks
  each key too: a public, plan-image, share-link, Explore or owner-pointer key is matched to its owner through
  the tour's `tour-owners/` pointer (the set's, or else the live one), and refused if that owner is
  marked for deletion or can't be found (a tour older than the pointers: its owner re-publishing
  writes them again). Remove the marker first only if the deletion itself was the mistake. The
  account markers are never restored; `takedown.ts --disable-owner` blocks an owner again if the
  set shows they were disabled.
- A key whose write fails (an R2 error, or a request that got no answer) is listed as `FAILED` and
  the script exits 1; the rest are restored. Run the same command again: create-only keeps what
  already came back.
- Restored bundles and share links are purged from the CDN (as an unpublish is), and Explore
  re-checks each entry, so a restored tour shows up within a minute. The writes bypass the tour's
  `TourPublisher`, so don't restore a tour its owner is editing at that moment.
- It doesn't bring back originals or tiles from a backup set. A deleted original is in the trash
  for 30 days (`--from-trash`, "Trash for deleted originals" below). If the originals are still
  there but tiles or manifests are gone, re-tile them ("Re-tiling"); a config whose original is
  gone shows as a missing pano in the editor.

**TODO (Joel): a second copy outside this bucket.** These backups live in the same bucket, under
the same account and the same API tokens, so they protect only against mistakes in code and
scripts: a bug or a bad run that deletes or overwrites content. They do **not** protect against
the bucket being deleted, a leaked R2 or account token (anyone who can delete `tours/` can delete
`backup/`), or losing the Cloudflare account. When that matters, add a second bucket, ideally in a
separate Cloudflare account with its own tokens (or another provider), and copy each completed set
there: a bucket binding to it in `admin-api` (repeated under both env blocks, and only after the
bucket exists, or the deploy fails), or a scheduled copy over the S3 API with that account's own
token. A bucket lock (retention) rule on the second bucket would also stop its copies being
deleted early, by anyone. The separation of credentials is what protects them; the same-bucket
sets stay as the quick path for everyday mistakes.

## Trash for deleted originals

Originals (up to 150 MB each) are not in the nightly backup: copying them every night would
double the bucket. Instead, every code path in `admin-api` that deletes an original moves it to a
private trash first (`services/admin-api/src/trash.ts`): it copies `panos/<owner>/<panoId>/original`,
body streamed and content type and custom metadata kept, to
`trash/<YYYY-MM-DD>/panos/<owner>/<panoId>/original` (the UTC day of the delete), and only then
deletes it. A copy that fails throws before the delete, so the original stays and the delete is
retried like any other interrupted one. The paths, all through `deletePano`:

- the owner's pano delete (`DELETE /api/admin/panos/:panoId`, Library's "Delete");
- tour delete, for the panos no other tour of the owner uses;
- account delete, and the daily sweep that finishes it.

**What skips it.**

- **Takedowns delete for real.** The operator route's `delete` action
  (`takedown.ts --delete`, `--quarantine`, `--all-tours`) passes `trash: false`, and an account
  delete skips the trash when the owner has the operator's `disabled.json` marker, which
  `takedown.ts --close-account` always sets first (it needs `--disable-owner`). Content taken down
  for legal reasons must not linger anywhere the owner or a restore could bring it back from:
  `--quarantine` already keeps the copy that must be kept, in `quarantine/<caseId>/`, and
  `--nothing-to-preserve` is the operator's word that nothing should be. A disabled owner who deletes
  their own account is deleted for real too.
- **Trash copies made before the takedown go with it.** An owner may delete a reported pano before
  the operator acts, leaving its original only in `trash/`. `--quarantine` copies the trash copies
  of the tour's scenes' originals (with `--all-tours`, every trashed original the owner has) as
  `quarantine/<caseId>/trash/<date>/...`. The route's `delete` then deletes the trash copies of
  the originals its `tour.json` names, and closing a disabled owner's account deletes every
  trashed original under their `panos/<owner>/`. That is one listing per day held plus a batch
  delete, about 64 R2 operations at most. Gap: a pano removed from the tour and deleted before
  the takedown, on an account that stays open, is not in the tour, so it stays in `trash/` until
  it ages out (31 days at most). Close the account, or find it with
  `restore-backup.ts --list-trash --sub`, if it must go sooner.
- **Oversized originals** (`tiler-consumer`'s `deleteOversizedOriginal`, "Tiling failure marker"
  below) are not trashed. They are not a delete anyone asked for: the file is over the size the
  app accepts, could only arrive by bypassing the web app, can never be tiled, and keeping it 30
  days would keep exactly the bytes that cleanup exists to drop. That code is also the tiler's.
- **A replace** (a new upload over the same pano) overwrites the original in place; that is
  `upload-api`'s presigned PUT, not a delete, and the old bytes are not kept.
- The no-proof branch of a pano delete (no original, no tombstone) has no original to move.

**Private, and not the owner's.** `trash/` is outside the CDN WAF rule's three public prefixes
(`/tiles/`, `/pub/`, `/slugs/`, fail-closed, "CDN custom domain"), so it is never served; the
deploy smoke test and the post-provision check both expect `403` for `cdn.<domain>/trash/x`. It is
outside `panos/`, so it never lists as a pano, never fires the R2 notification (no tiling job),
and doesn't count toward the owner's storage quota (`upload-api` lists `panos/<owner>/` only). It
is not in the backup (`BACKUP_SOURCES`).

**Retention.** The daily cron's `trash` task (`sweepTrash`, `17 3 * * *`, through `runDailyCron`)
deletes every `trash/<date>/` whose date is `TRASH_RETENTION_DAYS` (30) or more days before today.
A delete on day D is gone on day D+30 at 03:17 UTC: kept at least 29 days, never more than 31,
which is what the privacy policy says. A run spends at most `TRASH_SWEEP_BUDGET` (100) R2
operations (one per listing page or batch delete of up to 1,000 keys); what it doesn't reach is
still the oldest trash the next day, so it carries on from there. It logs `[trash] deleted N
object(s) past 30 days` and, when the budget ran out, `budget reached, the rest go tomorrow`.
Storage cost is 30 days of deleted originals, at most about 31 x a day's deletes.

**Restoring an original.** `restore-backup.ts` lists and restores the trash through the same
operator route (`POST /api/admin/operator/restore` with `"from": "trash"`). It needs the same
`R2_*` variables, and `OPERATOR_TOKEN` with `--apply`:

```bash
cd services/admin-api
# What is in the trash (one owner with --sub)
node scripts/restore-backup.ts --list-trash
node scripts/restore-backup.ts --list-trash --sub 'google-oauth2|1234'
# One pano (the newest copy; --date <YYYY-MM-DD> picks a day), then everything of one owner
node scripts/restore-backup.ts --from-trash --pano <panoId>
node scripts/restore-backup.ts --from-trash --pano <panoId> --apply
node scripts/restore-backup.ts --from-trash --sub 'google-oauth2|1234' --apply
```

It is create-only unless `--overwrite` (an original uploaded since stays), refuses an owner whose
account is marked for deletion (remove the marker first only if the delete itself was the
mistake), and keeps the trash copy until it ages out. A restored original fires the R2
notification like an upload, so the pano re-tiles on its own. Its `config.json` (title, hotspots)
went with the pano: bring it back from the backup set of the day before the delete
(`--date <day> --tour <tourId>` or `--sub <sub>`; create-only, so nothing current is touched), and a
tour that still names the pano shows it again once both are back.

## Unsaved floor-plan images

A tour save sweeps that tour's plan images ("CDN purge on delete"), but an upload nobody saves
(an editor closed before Save, a draft never restored) would wait for a save that may never come.
The daily cron's `plan-sweep` task (`sweepUnsavedPlans`, `services/admin-api/src/plan-sweep.ts`)
lists `pub/plans/` and judges each tour's images:

- **No owner pointer** (no readable `tour-owners/<tourId>.json`): nothing goes. Without the
  pointer the sweep can't find the `tour.json`, and a saved but unpublished tour would look
  deleted, so it has no evidence either way. These tours are counted and logged.
- **The tour is gone** (the pointer names an owner whose `tour.json` isn't there, and there is
  no live bundle `pub/tours/<tourId>.json`): its images older than a day go. Deletes take
  `tour.json` before the pointer, so this is a delete that stopped half-way or raced an upload.
- **The tour exists**: images older than **7 days** that neither the stored `tour.json` nor the
  live bundle names go. 7 days is the editor's draft-autosave window (`DRAFT_MAX_AGE_MS`), so a
  plan a local draft holds survives as long as the draft can be restored (an image is aged from
  its upload, not from the draft's last autosave, so a draft kept alive past a week by editing
  can lose a plan it never saved).
- **Can't tell**: a `tour.json` or bundle that isn't JSON, or a `plan` that doesn't parse, might
  name any image, so all of that tour's images stay.

A tour whose images are all younger than a day costs nothing beyond the listing; one being judged
costs up to 4 R2 operations (pointer, `tour.json`, bundle, one batch delete), or 1 with no
pointer. A run spends at most
`PLAN_SWEEP_BUDGET` (400) operations; if it runs out it saves where it got to in
`ops/plan-sweep/cursor.json` (`{ v, startAfter }`, private like the rest of `ops/`) and the next
day's run carries on from there. A pass that reaches the end deletes the cursor, so the next one
starts from the top. Deleted images are purged from the CDN by URL, as the per-save sweep does.
It logs `[plan-sweep] deleted N unsaved plan image(s) of M tour(s)`, with `budget reached, the
next run carries on` on a partial run, and `left N tour(s) alone with no owner pointer` when it
skipped any.

The sweep can only judge a tour through its owner pointer, which tours created before pointers
existed (#121) don't have unless they were published since, and which a save writes only
best-effort. Every tour save that carries a plan writes the pointer if it is missing (one `HEAD`
after the first), and the cover backfill (`backfill-covers.ts`, "Cover and Explore backfill")
writes the missing pointers of every tour. **Run `backfill-covers --apply` once after deploying
this, in each environment, before relying on the sweep:** until then tours without a pointer
are skipped, so their unsaved images stay (safe, but not swept). A `left N tour(s) alone` line
in the logs after the backfill means a pointer write failed since; running the backfill again
fixes it.

---

## Explore

`https://panote.dev/explore` (and `panote.io`) lists every **Public** tour, newest first, 24 to a
page with a "Load more" cursor. Unlisted tours are never listed. Cards show the cover, title and
scene count and link to `/s/<slug>`; nothing on them names the owner. Code:
`services/admin-api/src/explore.ts` (writes), `services/public-api/src/explore.ts` (reads),
`apps/website/src/explore/`; schemas and keys in `@internal/contracts` (`explore.ts`, `keys.ts`).

**Storage: R2 only, under `explore/`.**

| Key | What | Written by |
|---|---|---|
| `explore/index/<rank>-<tourId>.json` | The card: `{ v, tourId, slug, title, sceneCount, cover, publishedAt, listedAt, updatedAt }`. `rank` is `9999999999999 - listedAt ms`, 13 digits, so an R2 list (ascending) is newest-listed first and a page is one `list` call. `cover` is `{ panoId, version, image: "og" \| "preview" }` (the start scene's `og.jpg` or `preview.webp`) or `null` | admin-api, inside the tour's `TourPublisher` |
| `explore/tours/<tourId>.json` | Pointer `{ v, key }` to the tour's entry, so a removal needs only the tourId. It outlives the entry while the tour exists (see below), so the key it names keeps the tour's listing time | same |
| `explore/hidden/<tourId>.json` | Operator marker `{ v, hiddenAt }`: never list this tour | the takedown route (`hide` / `unhide`) |

Every key is owner-free, like `pub/`. A tour keeps its `listedAt` (its place in the list) across
Saves, renames and republishes, and also through a trip to Unlisted and back, a start scene that
isn't ready, or the owner's Stop sharing and sharing again (and an operator `unpublish`): those
delete the entry but keep the pointer, and listing the tour again reuses the key it names, so
none of them can bump a tour to the top as new. A tour delete, an account delete, an operator
`delete` or `hide`, and an unreadable pointer remove the pointer as well; after those (or an
operator `unhide`) a tour is listed as new.

**New accounts are held back.** A tour whose owner's account is younger than
`NEW_ACCOUNT_HOLD_DAYS` (7, an `admin-api` var; `"0"` turns it off) is published and works by link
as usual, but stays off Explore and is `noindex` until the account is that old. The account's age
is worked out in `admin-api` from R2, never from the client (`src/account-age.ts`): on the owner's
first publish it lists `panos/<owner>/` for the oldest `original` (R2's own upload time) and
latches that time, create-only, in `accounts/<owner>/since.json` (`{ v, since }`, private like the
other account markers; account deletion removes it). Every publish (each Save) then costs one
`GET` of it and writes `heldUntil` (ISO, `since` + the hold) into the public bundle while that is
still ahead; a later Save drops it. The website's script and the SPA add
`<meta name="robots" content="noindex">` while `heldUntil` is in the future, so the tag goes
without a Save. A held tour's first listing is filed at `heldUntil` instead of now, a time in the
future; public-api starts every list at the current time (`startAfter` the rank of now, and a
cursor can't point earlier) and drops any entry whose `listedAt` is later than now, so the tour
appears on Explore, at the top as new, the moment its hold ends, with no Save needed. Deleting and
re-uploading every pano resets nothing once `since.json` exists. The owner-facing copy says so:
the share modal's Public option reads "once your account is a week old", as does the privacy
page, so change both if the var changes. The public bundle `pub/tours/<tourId>.json` now also carries
`customMetadata: { visibility, slug }`, so the read side checks a listed tour with a `HEAD`.

**Writes.** Every publish (each Save), slug rename and visibility change rewrites the entry after
the bundle: listed while the bundle is Public, the start scene's manifest exists (a ready scene)
and there is no hidden marker; removed otherwise. These writes are best-effort: a failure is
logged as `[explore] index update failed` and the publish still succeeds, so at worst a tour is
missing from Explore until its next Save (or the backfill below). Removal on unpublish is not best-effort: the owner's
Stop sharing, tour delete, account delete (and its daily sweep), and the operator's `unpublish`
and `delete` (so also any later takedown mode built on them) all go through `unpublish` in
`publish.ts`, which deletes the bundle, then the entry and (except for a Stop sharing or operator
`unpublish`, which keep the tour's place) the pointer, then `publish.json`. If the
entry delete throws, the request fails and `publish.json` stays, so a retry finds the tour and
finishes it.

**Reads.** `GET /api/explore[?cursor=<rank>-<tourId>]` on public-api answers
`{ tours: [...], cursor: string | null }` (`ExplorePageSchema`, which the website validates). It
re-checks every entry before showing it: dropped if `pub/tours/<tourId>.json` is gone or not
Public, if `explore/hidden/<tourId>.json` exists, or if the entry doesn't parse or has no scenes.
So an entry that outlived its tour (a failed removal, a race with an operator hide) is never
shown, and so is one filed later than now (a held tour). Per page that is one `list` plus a `GET`
and two `HEAD`s per entry, and at most three
`list` calls when many entries are dropped. Responses are `Cache-Control: public, max-age=60` and
kept in the edge cache (Cache API, keyed by path plus `cursor` only), so a taken-down tour can
linger on a cached Explore page for up to 60 s; its `/s/<slug>` link stops working at once. A bad
cursor is `400`; the limiter is `EXPLORE_LIMITER` (Rate limits).

**Exposure: nothing new on the CDN.** `explore/` is outside the CDN WAF rule's three public
prefixes (`/tiles/`, `/pub/`, `/slugs/`), so `https://cdn.panote.dev/explore/...` is `403` like
`tours/`; the index is only read through public-api. No WAF or cache rule changes.

**Website.** `/explore` is a page in the SPA, linked from the header and the footer's Product
column. The website's script also runs for `/explore` (`run_worker_first`) to give it its own
`<title>`, description, `og:title`, `og:description` and `og:url` (the site-wide preview image
stays). It is in the production sitemap.

**Hide from Explore without unpublishing.** `takedown.ts --slug <slug> --hide-from-explore`
writes the hidden marker, then removes the entry. Publish never relists a hidden tour, and the
read side drops it even if an entry slipped through. `--show-on-explore` deletes the marker and
relists the tour from its current bundle if it is still published and Public. The marker is
owner-free and is left behind by a tour or account delete (tourIds are never reused).

### Cover and Explore backfill

Some tours carry state from before the code that writes it, and only their owner's next Save
fixes it: a Public tour published before Explore existed (#126) isn't listed at all; an Explore
card's cover names a tile version, so after a re-tile and the tile sweep it points at a version
that is gone and the card shows its placeholder; a tour saved before start-scene covers (#111)
shows its first scene on the dashboard instead of the starred one; and a tour created before
owner pointers (#121), never published since, has no `tour-owners/<tourId>.json`. Link previews
(`og:image`) need nothing: the website reads the start scene's manifest on every request, and a
pano with no `og.jpg` is the og.jpg backfill's job ("Link-preview image").

`services/admin-api/scripts/backfill-covers.ts` fixes all of it, idempotently: a tour already up
to date needs nothing, so a second run reports no changes. It calls `admin-api`'s operator route
`POST /api/admin/operator/backfill` (`OPERATOR_TOKEN`, the takedown route's secret), which walks
`tours/` through the binding a page at a time (`{ cursor, limit, apply }`, 10 tours a request by
default, at most 25), so it needs no R2 credentials: `R2_BUCKET` only picks the environment and
its admin-api origin, with the usual `--allow-bucket` for anything but a `-dev` bucket. For each
`tour.json` it:

- rewrites the tour's `customMetadata` (title, scene count, cover) when it differs from what a
  Save would write, with the same body and only over the version it read (`If-Match`), so a Save
  in between wins. An editor open on that tour then gets the usual "changed elsewhere" conflict
  on its next Save, so run it at a quiet time;
- writes the owner pointer if there is none (create-only, the sub decoded from the key's owner
  segment). The daily plan sweep skips any tour without one ("Unsaved floor-plan images"), so
  run this with `--apply` before relying on that sweep;
- re-syncs the Explore entry through the tour's `TourPublisher`, as a publish does, when the tour
  is Public, published, not hidden, has a ready start scene, and has no entry or an entry whose
  cover differs from the start scene's current one. A tour listed for the first time this way
  takes its last publish time as its place, so old tours don't jump to the top.

```bash
export R2_BUCKET=pano-content-dev OPERATOR_TOKEN=...
cd services/admin-api
# What each tour needs, changing nothing
node scripts/backfill-covers.ts
# Do it
node scripts/backfill-covers.ts --apply
```

It prints one line per tour that needs (or got) something, `update <tourId>: cover,
owner-pointer, explore`, and the totals. A skipped tour (a `tour.json` that doesn't parse) is
listed with the reason, and so is a tour whose cover fix lost a race with a save (`tour.json
changed since read`: the save wrote the right cover itself). Not run against any environment yet.

---

## Abuse controls

Groundwork only: no per-owner quota is set yet. Code: `services/public-api/src/index.ts`,
`services/upload-api/src/{index,quota}.ts`, `services/admin-api/src/operator.ts` and
`services/admin-api/scripts/takedown.ts`.

### Rate limits

Workers Rate Limiting bindings (`ratelimits` in each `wrangler.jsonc`, repeated in both env
blocks). public-api keys by client IP (`CF-Connecting-IP`): an IPv4 address as is, an IPv6
address by its /64 (the first four hextets, `::` expanded), since one IPv6 client usually holds a
whole /64 and could otherwise rotate past any limit. Over the limit the route answers `429 {"error":"rate limited"}` with `Retry-After: 60`
(the binding's `period`; it doesn't report when the window resets). The counters are per
Cloudflare location and eventually consistent: a brake, not an exact count. If the binding itself
errors the request goes through and `rate limiter unavailable` is logged.

| Worker | Binding | Route | Key | Limit | namespace_id dev / production |
|---|---|---|---|---|---|
| `upload-api` | `UPLOAD_URL_LIMITER` | `POST /api/upload-url` | owner (Auth0 sub), checked after the JWT | 60/min | `1101` / `2101` |
| `admin-api` | `WRITE_LIMITER` | every `POST`/`PUT`/`PATCH`/`DELETE` under `/api/admin/*` except the operator routes (takedown, restore) | owner (Auth0 sub), checked after the JWT, before any R2 read | 300/min | `1301` / `2301` |
| `admin-api` | `READ_LIMITER` | every `GET`/`HEAD` under `/api/admin/*` | owner (Auth0 sub), checked after the JWT, before any R2 read | 1200/min | `1302` / `2302` |
| `admin-api` | `INSIGHTS_LIMITER` | `GET /api/admin/tours/:id/insights`, on top of `READ_LIMITER` | owner (Auth0 sub) | 30/min | `1303` / `2303` |
| `admin-api` | `OPERATOR_LIMITER` | the operator routes (takedown, restore), every request counted before the token check | client IP (IPv6 per /64) | 120/min | `1304` / `2304` |
| `admin-api` | `PANO_DELETE_LIMITER` | `DELETE /api/admin/panos/:panoId` and `DELETE /api/admin/tours/:tourId` (which sweeps the panos only that tour used), on top of `WRITE_LIMITER`; a cost cap on the R2 sweeps and CDN prefix purge each one makes, not a guard of the purge budget (CDN purge on delete). A delete that 404s still counts | owner (Auth0 sub) | 10/min | `1305` / `2305` |
| `public-api` | `VIEW_LIMITER` | `POST /api/tours/:id/view` | client IP (IPv6 per /64) | 30/min | `1201` / `2201` |
| `public-api` | `LIKE_LIMITER` | `POST /api/tours/:id/like` | client IP (IPv6 per /64) | 10/min | `1202` / `2202` |
| `public-api` | `EVENTS_LIMITER` | `POST /api/tours/:id/events` | client IP (IPv6 per /64) | 120/min | `1203` / `2203` |
| `public-api` | `ERRORS_LIMITER` | `POST /api/errors` | client IP (IPv6 per /64) | 20/min | `1204` / `2204` |
| `public-api` | `EXPLORE_LIMITER` | `GET /api/explore` | client IP (IPv6 per /64) | 60/min | `1205` / `2205` |
| `public-api` | `STATS_LIMITER` | `GET /api/tours/:id/stats` | client IP (IPv6 per /64) | 600/min | `1206` / `2206` |

`namespace_id` is ours to pick, an integer unique within the Cloudflare account; there is nothing
to create first (Cloudflare docs, "Rate Limiting" binding, checked 2026-10-21). Two bindings with
the same id share counters, so every binding and every env has its own. The dashboard doesn't show
these limits: watch for `429`s in Workers Logs. To change a limit, edit `simple.limit` in both env
blocks; `period` may only be `10` or `60`, and if it changes, change the matching constant
(`UPLOAD_URL_RATE_PERIOD_SECONDS`, `RATE_PERIOD_SECONDS`, and in
`services/admin-api/src/limits.ts` `WRITE_RATE_PERIOD_SECONDS`, which every other admin-api limiter
shares, and `PANO_DELETE_RATE_PERIOD_SECONDS`) too. The per-IP keys are coarse: an
office or a carrier NAT shares one IP, which is why those limits are well above what one browser
sends (a view per page load, an events beacon at most every 5s, a like per click). The IP is only
the limiter's key, held in Cloudflare's short-lived counters: nothing of ours stores it, and AE and
`TourStats` still never see it (the privacy rule in `docs/wave6-plan.md` holds). `admin-api`'s
300/min lets two editor Saves of a full tour through in one minute (each is up to `MAX_TOUR_SCENES`
= 100 configs, the tour and the publish); people editing by hand stay far below it. A Save cut off
by a `429` keeps the refused documents unsaved, and pressing Save again sends just those.
`admin-api`'s 1,200 reads a minute are four times the editor polling every pano still tiling once
each 10 s for 50 panos at once (a day's uploads), leaving room for a second tab and the editor's own
loads; a poll that gets a `429` tries again on its next turn. `STATS_LIMITER`'s 600 lets the admin
dashboard, which reads each tour's counts when it opens (up to 200 tours), open three times a
minute.

Request bodies are read through a capped reader (`readJsonBody`, `packages/worker-kit/src/body.ts`):
a `Content-Length` over the cap is refused before anything is read, and a body sent without one
(chunked) is counted as it streams in and cancelled once it passes the cap, so nothing past the cap
is buffered; the text is decoded as it arrives, so the bytes are never held twice. Over the cap
is `413`. The caps: `public-api`'s beacons and error reports 8 KiB (`MAX_BODY_BYTES`),
`admin-api`'s scene config `PUT` 14 MiB (`MAX_CONFIG_BODY_BYTES`), every other `admin-api`
write 256 KiB (`MAX_WRITE_BODY_BYTES`; a tour at its caps is under 50 KiB), and `upload-api`'s
`POST /api/upload-url` 8 KiB. A config at every schema cap is about 4.5 MiB in ASCII and 12.6 MiB
written entirely in 3-byte characters, so every config the schema allows fits as long as JSON
writes its text as itself: characters JSON escapes as `\uXXXX` (control characters, lone
surrogates) take 6 bytes each, and text made mostly of them can pass the cap (a `413`). One over the
backup's per-object limit (`BACKUP_MAX_OBJECT_BYTES`, 8 MiB) is stored but left out of the
backup, which reports it (see Backups).

Ids in a route or a hand-built body (`panoId`, `tourId`, a list `cursor`) must match `PANO_PATTERN`
and be at most 64 characters (`isContentId` in `@internal/contracts`, the same rule as every body
schema): anything else is a `400` in `admin-api` and `upload-api`, and `public-api`'s
`400 {"error":"invalid tourId"}`, before the id reaches an R2 key or a Durable Object.

### admin-api object caps

- **Tours:** at most `MAX_TOURS_PER_OWNER` (200, `@internal/contracts`). `POST /api/admin/tours`
  (new tour, upload into a new tour, dashboard Duplicate) answers `403 {"error":"tour limit reached"}`
  once the owner has 200 `tour.json`s, counted with one LIST of `tours/<owner>/`. A soft cap, like
  upload-api's: concurrent creates can each pass.
- **Configs:** `PUT /api/admin/panos/:panoId/config` answers `404 {"error":"pano not found"}` unless
  the caller has an original for that panoId, or already has a config there (a config-only pano
  from before this check, which can still be updated). The delete tombstone's `409` comes first.
- **Slugs:** a tour holds at most `MAX_ALIASES` (5) redirect aliases. A rename, or a publish with a
  new slug, that would make a sixth answers `409 {"error":"too many renames"}` and claims nothing;
  it works again once the oldest alias expires (`SLUG_ALIAS_DAYS`). Moving back onto an alias and a
  bare republish still work. An alias past its expiry stops counting at once, before the daily
  sweep deletes it. Unpublish (Stop sharing, takedown, and so tour delete) releases the tour's
  aliases as well as its live slug: an old shared URL then stops redirecting. Each released slug
  (live or alias, and those account deletion releases) is first held for its owner for
  `SLUG_HOLD_DAYS` (30, `src/slug-hold.ts`) in `slug-holds/<slug>.json` (`{ v, owner, expiresAt }`,
  `owner` a SHA-256 of the owner segment, never the sub; private, outside the CDN's WAF prefixes):
  until then a publish, rename or default slug from any other owner treats it as taken, so nobody
  can take over an old share link, while the same owner may claim it again from any of their
  tours (after an operator takedown, not even they can: see Takedown). A claim re-checks the hold after its create and gives the slug back if a release landed in
  between, or if that re-check fails (the error then fails the publish). The daily cron deletes expired holds. A rename's old slug needs no hold: it stays this
  tour's redirect alias for `SLUG_ALIAS_DAYS` (30) and is free for anyone once that ends. A short list of support and sign-in words is
  reserved (`RESERVED_SLUGS`, plus any slug starting `panote` or led by `login`/`signin`); a tour
  already live at a word reserved later keeps republishing at it.

### Likes

`POST /api/tours/:id/like` now refuses (`400 {"error":"invalid X-Client-Id"}`) an anonymous
`X-Client-Id` that isn't a lowercase v4 UUID (`CLIENT_ID_PATTERN` in `@internal/contracts`; the
website mints `crypto.randomUUID()` and replaces a stored id that doesn't match). A signed-in like
still dedupes by sub and ignores the header. Inside `TourStats`, one tour keeps at most
`MAX_LIKES_PER_TOUR` (100,000) `likedh:<hash>` keys; past that a new liker is neither counted nor
stored, so storage per tour is bounded.

The dedupe key never holds the liker's id: it is `likedh:` plus the hex HMAC-SHA-256 of the sub or
client id under the `LIKER_HASH_KEY` secret (`src/stats.ts`). Set it once per env and never
rotate it: a new key forgets who liked what, so everyone could like each tour once more. What
happens while it's unset depends on the `LIKER_HASH_FALLBACK` var (`wrangler.jsonc`):

- **dev (`allow`)**: `TourStats` uses an unkeyed SHA-256 of `panote:liker:v1:<who>` and logs
  `LIKER_HASH_KEY is not set` once per isolate. Likes keep working and no raw id is stored, but
  anyone who knows a sub can recompute its hash.
- **production (`refuse`)**: it fails closed. Every like answers `503 {"error":"likes
  unavailable"}` and logs an error; views and stats still work. Set the secret before
  production's first deploy.

Setting the secret on an env that already has unkeyed hashes (dev) lets each earlier liker like
again once. Keys stored raw before this change (`liked:<who>`) are rewritten as hashes, 128 per
request to that tour's `TourStats` (any route: view, like, stats) until none are left; a raw key
still waiting counts as a like. Nothing is stored to mark that done (a request that finds none
sets an in-memory flag), so a read of any tour id, or one after an account delete, creates no
state. The rewrite runs inside
`blockConcurrencyWhile`, and a like is hashed before `counts` is read, so only storage operations
(which hold the input gate) sit between that read and its write. With no way to hash (production
without the secret) the raw keys are left alone until the secret is set.

Likes, views (`POST .../view`) and Insights events (`POST .../events`) only count for a published
tour. Each answers `404 {"error":"tour not found"}`, and creates no Durable Object state and writes
no Analytics Engine point, unless the tour's public bundle `pub/tours/<tourId>.json` exists:
`public-api` has a read-only `BUCKET` binding to `pano-content(-dev)` for that `HEAD`. A yes is
cached in the isolate for 30 s (`PUBLISHED_CACHE_MS`, `src/published.ts`, at most 1,000 tours), so
a busy tour costs about one `HEAD` (an R2 Class B operation) per isolate per 30 s, and after an
unpublish or a takedown its views, events and likes can still count for up to 30 s. A no is never
cached: an unknown id costs a `HEAD` per request, braked by the per-IP limit, and a tour counts as
soon as it is published. The website's view and events beacons ignore the `404`. Stats reads
(`GET .../stats`) don't check the bundle: a read stores nothing (an unknown id reads zeros), and the
admin dashboard reads the view counts of unpublished tours too. They are limited per IP
(`STATS_LIMITER`, see Rate limits).

Views and events are refused from other sites the same way error reports are (see Error reporting,
"Same origin only"): a `Sec-Fetch-Site` other than `same-origin`, or an `Origin` other than the
API's own, gets `403 {"error":"cross-origin"}` before the limiter. Otherwise any page could have
its visitors' browsers send views for any tour from their own IPs, past the per-IP limit. The
embed is not affected: the iframe sits on another site, but its document is served from Panote's
own origin (`/s/<slug>/embed`), so its beacons are same-origin requests. An embed placed in a
`sandbox` iframe without `allow-same-origin` has an opaque origin, and its views stop counting; the
embed snippet has no `sandbox`. A local Vite dev server proxying `/api` sends a localhost `Origin`,
so its views and events are refused too. A refusal logs
`[cross-origin] refused { route, secFetchSite, origin }` (the route as a pattern, never the
tourId), at most once a minute per isolate, so a page or embed served from an unexpected origin
shows up in Workers Logs. The origins: dev serves the website (tour pages `/s/<slug>`, embeds
`/s/<slug>/embed`) on `panote.dev/*` and `public-api` on `panote.dev/api/tours/*`,
`/api/errors` and `/api/explore`; production the same on `panote.io`. Same origin in both.

### Owner quotas

`upload-api` checks owner quotas (`src/quota.ts`) last before it signs an upload URL, after the
auth, rate limit, body checks and the account markers. Three vars, set in both env blocks of
`services/upload-api/wrangler.jsonc`:

- `MAX_PANOS_PER_OWNER` (`500`): most panos (directories under `panos/<owner>/`) one owner may
  hold. A replace doesn't add a pano, so it is allowed at the limit, but not once the owner is
  already over it (the limit was lowered under them).
- `MAX_BYTES_PER_OWNER` (`21474836480`, 20 GiB): most bytes of originals one owner may hold,
  counting the declared `size` of the upload; a replace frees the old original's bytes.
- `MAX_UPLOADS_PER_OWNER_PER_DAY` (`50`): most upload URLs one owner may get in a rolling 24
  hours, new uploads and replaces alike (each is a tiling job), counting this one. It bounds
  tiling compute per account (a job is about $0.01); the per-minute backstop is the 60-per-minute
  `UPLOAD_URL_LIMITER`, and across all accounts the global daily ceiling below and the tiler's
  `max_concurrency`.

Each var is optional: unset or empty means unlimited, and costs nothing. With the pano or byte
limit set, the owner's `panos/` prefix is listed (S3 `ListObjectsV2`, one Class A operation per
1,000 objects) in full on every upload-URL request: that is a known cost. A pano with a delete
tombstone (`deleting`) counts toward neither, and neither does a deleted original waiting in
`trash/` (it is outside `panos/<owner>/`). Over a limit: `403 {"error":"pano limit reached"}`,
`403 {"error":"storage limit reached"}` or `403 {"error":"daily upload limit reached"}`, checked
in that order; the admin app words each one (`packages/web-kit/src/api/http.ts`). A listing or
log write that fails is a `502` with no URL, and a value that isn't a non-negative integer refuses
every upload (`500`), so a typo can't silently lift a limit. They are soft caps: concurrent
requests can each pass, since each counts what is stored when it reads.

**Usage read.** `GET /api/upload-url` (same route, so no new Worker route) answers the account
page (`/app/account`) with what the caller holds and the three limits: `{panos, bytes,
uploadsToday, limits}`, counted as above from the caller's own prefixes, never a tour they edit.
It lists `panos/<owner>/` and `upload-log/<owner>/` whatever the limits are, spends the same
`UPLOAD_URL_LIMITER` budget, and `uploadsToday` stays 0 while the daily limit is unset (no log is
written then). Sign-in details come from `GET /api/admin/account`, read from the verified token.
"Sign out everywhere" is not offered: it needs an Auth0 Management API secret the Workers don't
hold.

**Upload log.** The daily limit counts URLs, not stored originals, so uploading and then deleting,
or asking for URLs and never using them, doesn't get round it. Before it returns a URL,
`upload-api` writes one empty object, `upload-log/<owner>/<issued, basic ISO 8601>-<panoId>`
(`uploadLogKey` in `@internal/contracts`); if that write fails, no URL. Each request lists
`upload-log/<owner>/` once (about one entry per URL in the past day, so a page or two at most) and
counts the entries from the past 24 hours. Older entries, and any name it can't read, aren't
counted and are deleted best-effort after the response (`waitUntil`, at most
`UPLOAD_LOG_PRUNE_MAX` = 50 per request). It sits outside `panos/` because `admin-api` lists that
prefix as the owner's panos, and outside the R2 notification rule (prefix `panos/`). It is private:
the CDN's WAF rule only lets `tiles/`, `pub/` and `slugs/` through. Account deletion removes
`upload-log/<owner>/` after the panos, and the daily sweep's "anything left?" check lists it too,
so an entry logged just before the deletion marker is caught. An owner who stops uploading keeps
up to a day's entries (empty objects) until their next upload-URL request. A Workers Rate Limiting
binding can't express a day (its period is 10 or 60 seconds), which is why the count lives in R2.

**Single-use upload URLs.** Counting URLs only bounds tiling if each URL makes one original. Every
PUT that lands fires an R2 object-create event, and under `panos/` that is a full tiling job, so a
URL that could be PUT to again and again (a presigned URL can, until it expires) would get round
the daily limit and keep the tiler busy for everyone. So `upload-api` signs a condition into every
upload URL, alongside content-type and content-length (`SignedHeaders=content-length;content-type;host;if-none-match`
or `...;host;if-match`):

- a new pano's original, and a floor-plan image (always a fresh key): `If-None-Match: *`, so once
  one PUT lands every other gets `412`;
- a replace: `If-Match: <ETag>` from the HEAD of the original it checks at presign time, so the
  URL overwrites only that object, once. A HEAD `200` with no ETag fails closed (`502`, no URL).

A signed header has to be sent, with exactly the signed value, or R2 answers `403`, so it can't be
dropped. The response carries the headers the PUT must send as `headers` (lowercase names, e.g.
`{"content-type":"image/jpeg","if-none-match":"*"}`), and the admin app's uploader
(`putFile` in `packages/web-kit/src/api/upload.ts`) sends them as given, so the condition lives in
one place. A PUT whose answer was lost and that is sent again gets `412`, and the uploader reads it
per case: for a new pano or a plan image (a fresh key only that URL can write) the file is there,
so it carries on as if the PUT had answered; for a replace, which can't tell its own earlier PUT
from another tab's replace, it asks once for a new URL and sends the file again (one more URL
toward the daily limit and the global ceiling), and a second `412` fails with "This panorama changed while it was
uploading". Bucket CORS must allow `if-match` and `if-none-match` on PUT (Bucket CORS above). One
gap is left: a replace whose bytes are identical to the current original keeps the same ETag, so
that URL can be PUT to again with those same bytes until it expires; each one builds the same
tile version again. The URLs last 120 s (`UPLOAD_URL_EXPIRY_SECONDS`, was 600): the uploader PUTs
the moment it gets one, and SigV4 checks expiry when the request arrives, so a slow upload that
started in time still finishes (unverified on R2: see "Known limitations").

To change a limit, edit it in both env blocks, run `pnpm --filter @service/upload-api run types`
(the vars are in the generated `env.d.ts`) and deploy.

**Global daily ceiling (the kill switch).** Every limit above is per Auth0 sub, so many throwaway
accounts would add up without bound. One `UploadCeiling` Durable Object (`src/ceiling.ts`,
binding `UPLOAD_CEILING`, `idFromName('global')`) counts the upload URLs issued and their declared
bytes per UTC day across every owner, pano originals and floor-plan images alike. Two vars, in both
env blocks:

- `MAX_UPLOADS_PER_DAY_GLOBAL` (`2000`): each URL is about one tiling job (about $0.01), so this
  holds tiling to roughly $20 a day, under the roughly $45 a day the five tiler containers
  (`max_concurrency: 5`) cost running flat out. It is 40 accounts' worth of the per-owner daily
  limit.
- `MAX_UPLOAD_BYTES_PER_DAY_GLOBAL` (`214748364800`, 200 GiB): at R2's $0.015 per GB-month, a full
  day adds about $3 a month of originals (plus their tiles), so a month at the ceiling adds about
  $90 a month of originals: slow enough for the billing alerts to catch.
  Real panoramas are 10-40 MB, so the upload count binds first; this one binds when someone sends
  near-150 MiB files.

The check comes last, after the owner's own limits pass (a request they refuse costs no DO call),
and is one RPC per URL: `reserve` reads today's count, and either counts the URL (one upload, its
declared `size`) or refuses it, in one synchronous step (the SQLite-backed `storage.kv` API, no
await between the read and the write), so parallel requests can't overshoot. If anything after
it fails (the upload-log write, or signing the URL), no URL is issued and the reservation is given
back (`release`, best-effort in `waitUntil`). It counts URLs issued, not PUTs, so it only bounds
tiling cost once each URL is single-use (#138); until then one URL can be PUT to again and again.
An upload that would pass either limit gets `503 {"error":"uploads paused"}` with `Retry-After` set to
the seconds until 00:00 UTC, and nothing is logged against the owner; the admin app says "Uploads
are paused for today. Try again tomorrow." and stops the rest of a multi-photo pick. Near the byte limit a large file can be refused while
smaller ones still get through; the copy says "paused" either way. The first refusal of each day
logs `upload ceiling reached` (a `console.warn` from the DO, visible in
Workers Logs and `wrangler tail`); the health check doesn't alert on it.

If the DO can't be reached, a single failure fails open (the per-owner limits still hold, so that
is no worse than before the ceiling existed), but three failures in a row in one isolate fail
closed with `502 {"error":"storage unavailable"}` until a call gets through. The count lives in
the isolate, so each new isolate still lets its first couple of requests through during a lasting
outage: this limits how far an outage lifts the ceiling rather than closing it outright. Empty vars lift a limit (both empty: no DO call at all); a
non-integer refuses every upload (`500`), as for the owner quotas.

The trade-off is deliberate: someone with enough accounts can use up the day's ceiling and pause
uploads for everyone until 00:00 UTC. A day without uploads costs less than an unbounded bill, and
it leaves time to disable the accounts (Takedown) and decide whether to raise the limit.

Operator steps, all by editing `services/upload-api/wrangler.jsonc` in both env blocks and
deploying (vars changed in the dashboard are overwritten by the next deploy):

- **Raise it** (real traffic is close): raise either var. Today's count is kept, so a raised limit
  reopens uploads at once if today's count is under it.
- **Pause uploads now** (an attack, a runaway bill): set `MAX_UPLOADS_PER_DAY_GLOBAL` to `"0"`.
  Every upload URL gets the 503 until it is set back.
- **Reset it**: there is no reset route; the count starts again at 00:00 UTC on its own. To reopen
  uploads earlier the same day, raise the limit above today's count.

**Floor-plan images.** Plan images live under the owner-free `pub/plans/<tourId>/`, so counting
them in `MAX_BYTES_PER_OWNER` would mean listing every tour's prefix on each request. Instead a plan
upload lists only its own tour's prefix (one more `ListObjectsV2`) and is refused with
`403 {"error":"plan storage limit reached"}` once the images there plus the declared size would pass
`MAX_PLAN_BYTES_PER_TOUR` (16 MiB, four full-size plans, in `src/index.ts`). That covers the
live image, the one a share link may still show, and a few uploaded but not saved; `admin-api`
deletes unused ones an hour old on the tour's next save. The listing follows every page, but the
cap is soft: it only sees images already uploaded, not URLs issued and not yet used. The admin
uploads at once, so in normal use a tour stays near 16 MiB. A client that takes its URLs first and
uploads after can get a day's worth through one check (the owner's 50 URLs at 4 MiB), so one tour
can reach about 216 MiB, and over many days an owner's plan images across 200 tours about 40 GiB.
Plan uploads also count toward the daily limit and the global ceiling, which bound how fast that
can grow.

**Not counted: tiles and JSON.** Tiles (`tiles/<panoId>/`) are derived from originals and grow with the
original's pixels (capped by the tiler's pixel limit), so `MAX_BYTES_PER_OWNER` and the pano limit
bound them indirectly; superseded tile versions are deleted by the daily
`tile-gc/` sweep. There is no cheap exact per-owner signal (tiles sit under an owner-free prefix and
are written by the container after the URL is issued), so they aren't counted. Configs, tours and
bundles are small JSON capped by `admin-api`'s own limits.

### Support email

The admin app's account menu and Account page (`/app/account`, "Help") have a **Contact support**
link: a `mailto:hello@panote.io` whose body starts with `Account ID: <Auth0 user id>`, the same id
the page shows. Panote stores no emails, so that line is how you find the account a message is
about; it is the `--sub` that `delete-account.ts`, `restore-backup.ts` and `takedown.ts` take. A message without it (written from the
website footer, say) needs the user's tour link, or a search by email in the Auth0 dashboard.

### Report link

The visitor viewer (`/s/<slug>`, not the embed) has a **Report** chip at the end of the tour bar
(a flag only, on a phone). It's a `mailto:hello@panote.io` with the subject "Report a tour" and the
tour's share link in the body. Reports arrive at the Email Routing address like any other mail; act
on them with the takedown script below, following the procedures after it. What a reporter may
send, and what we promise to do, is the website's `/content-policy` page
(`apps/website/src/legal/Legal.tsx`, linked from the footer and the Terms).

### Takedown

Two ways to stop abuse, usually together:

- **Take a tour down.** admin-api's operator-only route `POST /api/admin/operator/takedown`
  (`{ sub, tourId, action: "unpublish" | "delete" | "hide" | "unhide" }`, header `X-Operator-Token`) runs exactly what
  the owner's own unpublish or tour delete runs, through the tour's `TourPublisher`, with the CDN
  purge, except that a `delete` lists every tile key it deletes and purges them **by URL** (100 a
  request), never by prefix, so it doesn't depend on the account's prefix-purge budget. The purge
  runs before the route answers, bounded to 100 requests (retries included; 10,000 URLs), 20
  seconds, and the subrequests the delete's own R2 calls left of the invocation's 1,000 (it
  counts them), and stops at the first batch that still fails; the rest is queued for the cron,
  ahead of everything else. A takedown with more than the route's first 10,000 URLs drains the
  rest at about 3,000 URLs per 15-minute cron run. The script gives the route 2 minutes. The
  answer says what it did: `{ action, purged, purge: { status, purged, pending, failed } }`. The
  top-level `purged` is a misnomer kept for older scripts: it is the number of purge targets
  **planned**; `purge.purged` is what went through. `status` is `none`, `purged`, `pending`
  (queued, retried every 15 minutes), `failed` (dead-lettered or not queued; see Dead letters) or
  `skipped` (no `CF_PURGE_TOKEN`/`CDN_ZONE_ID`). `unpublish` removes the share link, bundle and slug and keeps the tour and panos (their
  tiles under `tiles/<panoId>/` and the tour's floor-plan image under `pub/plans/<tourId>/` stay
  reachable by anyone who has the URL); `delete` also deletes the tour, its floor-plan images and
  every pano no other tour of that owner uses, tiles included, purged from the CDN. Unlike the
  owner's own delete it keeps no trash copy of the originals, and deletes the trash copies of the
tour's originals the owner had already deleted ("Trash for deleted originals"). Both
  also take the tour off Explore, and so does every script mode built on them (`--quarantine`,
  `--all-tours`, `--close-account`'s sweep). Their released slugs (live and aliases) are held for
  `SLUG_HOLD_DAYS` (30) for **no** owner (`owner: "takedown"` in `slug-holds/`), so not even the
  owner taken down can republish at them until the hold ends. `hide` only takes it off Explore and keeps it off
  (the tour stays live by link, so there is nothing to purge); `unhide` lists it again if it is
  still published and Public (see Explore). It answers `404` for a missing or wrong token, and
  always while the `OPERATOR_TOKEN` secret isn't set on that env, so the route doesn't exist until
  you set it. It skips the write gate (no Auth0 user); instead `OPERATOR_LIMITER` allows 120
  requests a minute per client IP, takedown and restore together, every request counted before
  the token is checked, so wrong guesses spend it too (`429` with `Retry-After: 60`; see Rate
  limits). `takedown.ts` and `restore-backup.ts` wait out a `429` (its `Retry-After`) and send the
  request again, up to 5 times, so a long `--all-tours` or a restore of thousands of keys still
  finishes.
- **Disable the owner.** A marker `accounts/<owner>/disabled.json` (`{ v, disabledAt, reason? }`).
  While it exists every `admin-api` write and `upload-api`'s upload URL answer
  `403 {"error":"account disabled"}` (one more R2 `HEAD` each, in parallel with the deletion
  marker's, failing closed); reads still work, and so does the owner's own account delete. A
  deleted account answers `410` first. The account-deletion sweep never touches it, so it outlives
  an account delete and the same sign-in stays blocked. Removing it re-enables the owner. It
  doesn't take anything down by itself.

`services/admin-api/scripts/takedown.ts` does both, and on top of them:

- **`--quarantine <caseId>`** keeps a private copy before anything is removed: the tour's
  `tour.json` and `publish.json`, its public bundle, its slug records, every floor-plan image under
  `pub/plans/<tourId>/` (named or not), and the original and
  `config.json` of every scene in the tour or its bundle, each copied byte for byte (content type
  kept, create-only so a rerun keeps the first copy) to `quarantine/<caseId>/<its key>`, plus
  `quarantine/<caseId>/case.json` (`{ caseId, sub, tourIds, keys, firstAt, lastAt, reason? }`).
  Each copy is checked with a `HEAD` and only then does the tour go through the route's `delete`.
  Tiles aren't copied: they're derived from the original. `quarantine/` is outside the CDN WAF
  rule's three public prefixes (`/tiles/`, `/pub/`, `/slugs/`, see "CDN custom domain"), so it is
  never served, and no Worker reads, lists or deletes it: the account-deletion sweep only touches
  `tours/<owner>/`, `panos/<owner>/` and the owner's public keys. A case id is lowercase letters,
  digits and `-` (e.g. `2026-10-22-report-3`); one case holds one owner. Each copy is checked for
  size and, where both ETags are content hashes, ETag. `case.json` is rewritten only if it hasn't
  changed since it was read. `--quarantine` needs `--disable-owner`, so the owner can't write
  between the copy and the delete.
- **`--all-tours`** applies the tour action to every tour the owner has (named by `--sub`, or by
  any one of their tours' `--slug`/`--tour`), one at a time, so the last delete also takes the panos
  the tours shared. With `--quarantine` it also copies every pano the owner has, in a tour or not.
- **`--close-account`** writes the account-deletion marker, as the owner's own Delete account
  does (see "Account deletion"): the next daily sweep deletes what is left (panos in no tour, with
  their tiles, purged), and the Auth0 user is yours to remove from the `delete-account.ts --list`.
  It needs `--disable-owner` too.
- **`--delete` keeps no copy, so it needs `--nothing-to-preserve` as well**, the operator's word
  that nothing it destroys may be evidence. `--close-account` needs the same, unless it goes with
  `--all-tours --quarantine <caseId>`. If in doubt, quarantine.

After a quarantine the script `HEAD`s each pano's manifest and names any whose tiles are still
public: a pano another of the owner's tours still uses. `--all-tours` takes those down too.

The script prints the route's purge outcome for each tour, then checks it: before an `unpublish`
or a delete it notes each tour's public bundle and, for a delete, each pano's manifest and one tile
(up to 20 panos, only keys that exist), and afterwards fetches them from the bucket's CDN
(`https://cdn.panote.dev` for `pano-content-dev`, `https://cdn.panote.io` for `pano-content`, or
`CDN_ORIGIN`; no check for another bucket), skipping panos whose tiles were kept. It ends with
`CDN check: none of N URL(s) checked is served any more`, or `CDN STILL SERVES …` with the URLs and
**exit code 2**. Then: if the purge was `pending`, rerun a check after the next 15-minute cron (a
plain `curl -sI <url>` will do); if it persists, purge those URLs by hand (dashboard: the zone →
Caching → Configuration → Custom Purge) and look at `admin-api`'s `cdn purge failed` logs. The
check only sees the edge nearest you.

It runs like the account-delete script: Node 24 straight from TypeScript, a built workspace, the
same R2 S3 credentials, and the same rule that anything but a `-dev` bucket is named twice with
`--allow-bucket`. Tour actions also need `OPERATOR_TOKEN` (the same value as the `admin-api`
secret) and call `https://panote.dev` for `pano-content-dev` and `https://panote.io` for
`pano-content`. `ADMIN_API_ORIGIN` overrides that, but any origin other than the bucket's default
also needs `--allow-bucket <bucket>`, so a dev bucket can't quietly be sent to production's
admin-api.

```bash
export R2_ACCOUNT_ID=... R2_BUCKET=pano-content-dev R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=...
export OPERATOR_TOKEN=...    # only for a tour action (--unpublish, --quarantine, --delete, --hide-from-explore, --show-on-explore)
# Report only: which tour the share link is, who owns it, whether they're disabled
node services/admin-api/scripts/takedown.ts --slug old-town
# What it would do, without doing it
node services/admin-api/scripts/takedown.ts --slug old-town --unpublish --disable-owner --dry-run
# Copyright: take the tour's share link down (--reason only goes with --disable-owner)
node services/admin-api/scripts/takedown.ts --slug old-town --unpublish
# Illegal images: block the owner, keep a copy of everything, take it all down, close the account
node services/admin-api/scripts/takedown.ts --slug old-town --disable-owner --reason 'case 2026-10-22-3' \
  --all-tours --quarantine 2026-10-22-3 --close-account
# Delete outright, keeping nothing (spam, say); --tour takes a tourId instead of a slug
node services/admin-api/scripts/takedown.ts --tour <tourId> --delete --nothing-to-preserve
# Keep it live by link but off Explore (and back again)
node services/admin-api/scripts/takedown.ts --slug old-town --hide-from-explore
node services/admin-api/scripts/takedown.ts --slug old-town --show-on-explore
# An owner alone, by Auth0 user id
node services/admin-api/scripts/takedown.ts --sub 'google-oauth2|1234' --disable-owner
node services/admin-api/scripts/takedown.ts --sub 'google-oauth2|1234' --enable-owner
```

`--dry-run` writes nothing and calls no admin-api route, but it still makes the read-only R2
requests above (the slug `GET`, the owner lookup, the tour listing for `--all-tours`, the marker
`GET`/`HEAD`), so it needs the same R2 credentials and shows up in R2 request metrics.

Finding the owner: tour keys carry the owner and `pub/` deliberately doesn't, so admin-api writes
a pointer `tour-owners/<tourId>.json` (`{ v, sub }`, private like `accounts/`) when a tour is
created, and when one is published (which covers older tours). The write is best-effort: a
failure logs `[takedown] owner pointer ... not written` and the create or publish still succeeds. Tour delete and account delete
remove it. The script reads the pointer and checks that sub really holds the tour; with no
usable pointer (a tour that hasn't been published since) it falls back to listing `tours/` and
`HEAD`ing that tourId under each owner (one request per owner).
Pass `--sub` as well to skip both; the script then checks that this sub really holds the tour
(its `tour.json` or `publish.json`) and stops before writing anything if not, so a mistyped sub
can't disable someone else. A slug that is now a redirect alias still names its tour.
The owner is disabled before the tour comes down, so they can't republish in between. Every step
is idempotent: rerunning is harmless, and disabling again only rewrites `disabledAt`/`reason`.

Setup, once per environment: generate a long random token (`openssl rand -hex 32`), then
`pnpm --filter @service/admin-api exec wrangler secret put OPERATOR_TOKEN --env dev` (and
`--env production`). Keep it with the R2 credentials; rotate it by putting a new value.

### Takedown procedures

The public promises are on `/content-policy`; this is how to keep them. Keep a **case log**: a
private spreadsheet or document only the operator can open, one row per report, with the date,
case id, the tour link and tourId, the owner's sub, the reporter's email, the kind (copyright,
illegal, other), what you did and when, and the outcome. Nothing in the bucket replaces it; the
`reason` and `case.json` only point back to it.

**Copyright notice.**

1. Check the report has the tour's link, which work is the reporter's, and a way to reach them.
   If anything is missing, reply asking for it and do nothing else yet.
2. Run the report-only command on the link to find the tour and owner, then
   `--unpublish` (the case log, not the bucket, records why). That takes the share link down and
   keeps the tour in the owner's account so it can be restored, **but it leaves
   `tiles/<panoId>/` reachable by direct URL**: anyone who kept a tile or preview URL can still
   load the image. And without `--disable-owner` the owner can share it again from the share
   modal straight away (only the editor's Saves leave it off), so add `--disable-owner` while the
   case is open if they shouldn't. For the infringing image
   itself, use `--disable-owner --quarantine <case id>` (keeps a copy for the dispute and deletes
   the tour, its panos and their tiles, purged) or, if nothing needs keeping,
   `--delete --nothing-to-preserve`. A dispute can then only restore from the quarantine copy, by
   hand.
3. Email the owner (their address is on their Auth0 user): which tour, that it was taken offline
   after a copyright report, what the report said, and that they can reply if it was a mistake.
4. Log it, and check the log for the owner's earlier upheld notices (see repeat infringers).

**Disputes.** If the owner replies that it was a mistake (it is their own work, or they have
permission), weigh both sides and decide. Panote follows no formal counter-notice process. To put
it back, tell the owner they may share the tour again from its share modal (it was only
unpublished; the takedown left the sharing-stopped marker, so the editor's Saves don't republish
it on their own), and log it. Otherwise leave it down and log that.

**Illegal images (child sexual abuse material above all).**

1. Don't open, save, forward or screenshot the images, and don't email the owner. Note only the
   link and the tourId.
2. Run, the same day: `--disable-owner --reason '<case id>' --all-tours --quarantine <case id>
   --close-account`. That keeps the evidence in `quarantine/<case id>/`, takes every tour and
   tile down with the CDN purge, and closes the account. **Never `--delete --nothing-to-preserve`
   here**, and never delete anything under `quarantine/`.
3. Report it: in the US to NCMEC's CyberTipline (report.cybertip.org), otherwise the national
   hotline (inhope.org lists them) or the police, giving the link, the time, what you did, and
   that a copy is preserved. Note the report's reference in the case log.
4. Keep `quarantine/<case id>/` until the authorities say it may go, or as long as the law there
   requires (in the US, at least one year after the report). Don't remove the Auth0 user until
   then either; the disabled marker keeps that sign-in blocked meanwhile.

**Repeat infringers.** The case log is the record. Before closing a copyright case, count the
owner's earlier upheld notices (ones not reversed on dispute). At the third, close the
account: `--sub '<sub>' --disable-owner --reason '<case id>' --all-tours --unpublish`, then
`--sub '<sub>' --disable-owner --close-account --nothing-to-preserve` once nothing is in dispute,
and tell the owner.

**Legal pages.** They name no operator and hold no placeholders, as Panote is a personal
project. The production deploy still refuses to run if any file under `apps/website/src/legal/`
gains a `YOUR_` placeholder (`.github/workflows/deploy.yml`). Have them reviewed by a lawyer
before Panote becomes a business. Copyright notices go to the contact email; Panote has no
designated DMCA agent, so it does not have the US DMCA safe harbour.

---

## Tiling failure marker and alerting (unit B4)

- **Marker key:** `panos/<owner>/<panoId>/tile-failed`, body `{ reason, at, originalEtag }` — same
  owner-scoped shape as `configKey`/`deletingKey` (`packages/contracts/src/keys.ts`'s `tileFailedKey`,
  for a caller with the raw owner sub, and `tileFailedKeyFromOriginalKey`, for the consumer, which
  only has the already-encoded owner segment from the R2 notification key and must not re-encode
  it). `reason` is one of `'dlq' | 'oversize' | 'unprocessable-key' | 'unsupported'`. `originalEtag` is the R2
  `etag` (bare, native-binding form) of the original the failure was about — the read side (A2)
  must treat a marker whose `originalEtag` doesn't match the *current* original's etag as stale
  and ignore it (a later, different upload superseded the failed one). `reason` and `originalEtag`
  are also written as R2 `customMetadata` on the same object (review fix, 2026-09-26), so A2's list
  endpoint can read both off `bucket.list({ include: ['customMetadata'] })` with no extra GET — the
  same pattern the plan already uses for config/tour summaries (section 3.1).
- **Written by** `services/tiler-consumer/src/consumer.ts` on four permanent-failure paths: a
  dead-lettered message (the Worker now also consumes `pano-uploads-dlq[-dev]` itself, branching on
  `batch.queue` against an exact set of the two real DLQ names, not a substring test), an oversized
  original, a key `deriveUploadTarget` rejects, and a source the tiler refused (`422`,
  reason `unsupported`, see "Sources the tiler refuses"). A charset-invalid key (bad owner or panoId) now
  gets no marker at all — `tileFailedKeyFromOriginalKey` validates both segments and the write is
  skipped with a log line, rather than writing a marker keyed on a junk panoId.
- **Oversized originals are deleted.** Once the `oversize` marker is written, the consumer
  deletes the original (`deleteOversizedOriginal` in `services/tiler-consumer/src/failure-marker.ts`),
  after re-HEADing it to make sure it's still the one the event named; only that one key goes, the
  marker stays. `admin-api` reads an `oversize` marker with no original as `tiling: 'failed'`, so the
  upload chip and editor still show the failed state. It's kept when the pano already has a
  manifest (an oversized replace): the old tiles are still live and the original is what proves
  ownership of them. The web app rejects a file over 150 MB before upload, so this only happens to
  an upload that bypassed it (content-length isn't signed); the chip shows the generic "couldn't
  process this image" copy, since no failure reason reaches it.
- **Resurrection guard (review fix, 2026-09-26).** Before writing, the consumer HEADs the original
  at `bucket.head(<notification key>)`; the write is skipped (logged) if the original no longer
  exists, or if its etag differs from the R2 event's `object.eTag` (a newer upload already
  superseded the one that failed — a missing `eTag` is treated as unproven and also skipped,
  since Cloudflare's create-event notifications always carry one). This closes a race where a pano
  is deleted (`deletePano` sweeps `panos/<owner>/<panoId>/`) while its tiling job is still retrying:
  without the guard, the DLQ consumer's later marker write would recreate that exact prefix and make
  the pano list again under `GET /api/admin/panos`'s delimiter listing — a ghost pano. A second HEAD
  right after the write catches the narrower race where the original is deleted *between* the
  pre-write HEAD and the PUT; if so, the just-written marker is deleted again immediately.
- **Same-etag race (review fix, 2026-09-26) — narrowed on the write side, not closed.** Attempt A of
  etag E keeps retrying while a duplicate delivery or identical-bytes re-upload (attempt B, same etag)
  succeeds and clears any marker; if A then exhausts its retries and dead-letters, its marker write
  would otherwise resurrect a `failed` status for a pano that just tiled successfully. Before writing,
  the consumer also GETs `tiles/<panoId>/manifest.json` and skips (logged) if `manifest.version`
  equals `t${TILER_OUTPUT_VERSION}-<etag>` exactly (the format `services/tiler-consumer/src/container.ts`
  derives, `TILER_OUTPUT_VERSION` imported from a new `@internal/tiler/version` subpath export so the
  two never drift) — a full-string compare is fine here, unlike A2's read side (plan `tiling` rule),
  because both attempts racing over one failed upload necessarily run the same deployed tiler code.
  This check is best-effort and fail-open: a failure to read the manifest logs and falls through to
  writing the marker anyway, and there's a small remaining window between this GET and the marker's
  own PUT where attempt B's manifest write could land in between, unobserved — so a stale marker can
  still get written. It's harmless when it does: A2's `ready`-checked-first order reads the manifest
  (matching only the etag captured from its `version`, so it stays correct across a `TILER_OUTPUT_VERSION`
  bump) before the marker, so a pano whose manifest already matches its current original reports
  `ready` regardless of what a stale marker says.
- **Every R2 call in the marker path is wrapped (review fix, 2026-09-26).** The pre-write HEAD, the
  manifest race check, the write itself, and the post-write HEAD each catch their own errors: a
  pre-write HEAD failure skips the write and logs (same as "original doesn't exist" — an R2 error here
  must not be read as proof the original is fine), the manifest check failure logs and proceeds to
  write anyway, and a post-write HEAD failure only logs (the marker, once written, is left in place —
  there's nothing safe to undo without knowing whether the original is actually still there). None of
  these can throw out of `writeFailureMarker` and change the caller's ack/retry decision.
- **Cleared by** `services/tiler-consumer/src/container.ts` on the next successful manifest swap (a
  best-effort `deleteObject`, logged on failure, never thrown).
- **Read side (unit A2, not part of this PR):** `admin-api`'s planned `tiling: 'failed'` status
  checks this key's existence *and* that its `originalEtag` still matches the current original —
  see the plan doc's updated A2 rule. This PR only writes/clears the marker.
- **New binding:** `tiler-consumer` gets a native `BUCKET` R2 binding (`wrangler.jsonc`), alongside
  the existing S3-API credentials the container process already uses to reach the same bucket —
  two separate paths to `pano-content-dev`/`pano-content`, matching the rest of the plan.
- **New queue consumer.** The same Worker script now also consumes `pano-uploads-dlq[-dev]` (a
  second `queues.consumers` entry, `max_batch_size: 10`, `max_retries: 3`, `max_concurrency: 1`, no
  `dead_letter_queue` of its own — a dead-lettered message is always acked, never retried further).
  **Status: deployed in dev.** The DLQ consumer was attached to `pano-uploads-dlq-dev` by the
  2026-09-26 12:12 UTC dev deploy. The pre-deploy check this doc used to ask for (whether the DLQ
  already had a consumer or a backlog inherited from pano-viewer) was never run. If there was a
  backlog of old, percent-encoded-owner-scheme messages, the consumer would have acked each one with
  a warning and written no marker: only `tileFailedKeyFromOriginalKey` runs on the DLQ path, and it
  rejects an old-scheme key outright.

  **Backlog/log check: closed, inconclusive.** Tried to confirm whether that backlog was actually
  processed via the Workers Observability API's *events* view, but it fails on queue-consumer
  events with a zod validation error on `$workers.requestId`/`outcome` — fields a queue-consumer
  invocation apparently doesn't populate the way a `fetch` handler does. The *calculations* view,
  grouped by `$metadata.message`, does work for queue-consumer logs (used below to verify the DLQ
  alert end to end), but that was only found afterward, with nothing left from the original
  cut-over to look for. The backlog question itself stays closed without an answer, not resolved.
  To inspect the queue's current state directly:
  ```bash
  pnpm --filter @service/tiler-consumer exec wrangler queues info pano-uploads-dlq-dev
  ```
- **Alerting — email per dead-lettered batch, throttled.** After acking every message in a DLQ batch, the
  consumer sends one plain-text email through a `send_email` binding (`ALERT_EMAIL`,
  `services/tiler-consumer/src/alert.ts`). Subject `[panote] tiling failed permanently (N) - <queue>`;
  the body lists each key (or the message id, for a message with no `object.key`), whether its
  tile-failed marker was written or skipped, the UTC time and the queue name. The sender is the
  `ALERT_EMAIL_FROM` var, `tiler-alerts@panote.io`: it has to be on an Email Routing domain and
  only `panote.io` has routing (`panote.dev` doesn't). The recipient is the `ALERT_EMAIL_TO` secret.
  The binding is unrestricted in `wrangler.jsonc` (no `destination_address`) so the address stays
  out of the repo; Cloudflare still only delivers to verified Email Routing destinations. The send
  never throws and never changes ack behaviour: a failure logs `failed to send DLQ alert` with only the
  error's `code` and `name` (never its message, which may echo the recipient), and a missing
  `ALERT_EMAIL_TO`, `ALERT_EMAIL_FROM` or binding logs a warning and skips. The main queue never sends.
  **Throttle:** at most one email per queue per 30 minutes (`ALERT_THROTTLE_MS`). A batch inside
  the window sends nothing and logs `DLQ alert throttled for <queue>: N failure(s) held, M since the
  last email`; the next email after the window lists its own keys and says how many failures it
  left out (subject `(N + M earlier)`), whose keys are in the logs (`tile job dead-lettered`) and
  their tile-failed markers. A send that fails opens no window, so its items carry over too. The
  state is one small JSON object per queue in the content bucket, `ops/dlq-alert/<queue>.json`
  (`{ lastSentAt, held }`): no new resource, `ops/` is outside the CDN WAF rule's three public
  prefixes and the R2 notification's `panos/` prefix, and the DLQ consumer's `max_concurrency: 1`
  keeps its read-then-write from racing. If the state can't be read the email goes out anyway.
  Failures held back by the throttle no longer wait for a later batch: the Worker's 5-minute cron
  (the health check's) also runs `flushHeldDlqAlerts`, which emails `[panote] tiling failed
  permanently (N earlier) - <queue>` once a queue's window is over with failures still held, and
  resets the count (one `GET` per DLQ name when nothing is held; nothing at all while email isn't
  configured). A send that fails keeps the count for the next run. The DLQ consumer and the cron
  can both touch the state at once; at worst one failure is counted once too often or too few. This uses the structured `send({ to, from, subject, text })`
  API ([Workers API](https://developers.cloudflare.com/email-service/api/send-emails/workers-api/)).
  Chosen over a Tail Worker (needs log-string matching) and over Workers Observability / Cloudflare
  Notifications (no alert type for this, per current docs). **This is code and config only — it
  does not touch `panote.io`'s DNS, MX or Email Routing settings**, which are the account-recovery
  mail path (see DNS section).
  - **Confirmed, 2026-10-01: sending with Email Routing only.** The account has Email Routing on
    `panote.io` but has not been onboarded to Email Sending. The
    [limits page](https://developers.cloudflare.com/email-service/platform/limits/) says sends to
    verified destination addresses work "on any plan, including when only Email Routing is
    configured", as long as the sender is on a routing domain, and don't count toward sending
    quotas — confirmed live by the Ops step 2 test below, which landed in the inbox with no
    Email Sending onboarding done.
  - **Confirmed, 2026-10-01: same account.** This assumed `panote-tiler-consumer[-dev]` and the
    `panote.io` zone (and its verified destination address) are in the same Cloudflare account (a
    send from another account fails with `E_SENDER_NOT_VERIFIED`) — also confirmed by the same
    successful test.
  - **Ops step 1 — set the recipient.** **Status: set for dev, outstanding for production.**
    ```bash
    pnpm --filter @service/tiler-consumer exec wrangler secret put ALERT_EMAIL_TO --env dev
    ```
    Enter the owner's verified Email Routing destination address exactly — on dev this is a `+tag`
    Gmail variant, and it must be byte-identical to the verified address, or the send fails with
    `E_RECIPIENT_NOT_ALLOWED`. Repeat with `--env production` once production is provisioned.
  - **Ops step 2 — verify after the next dev deploy.** **Status: done, verified 2026-10-01.** Sent
    a test message straight to the DLQ and checked the inbox. wrangler 4.120 has no command for
    sending a queue message, so this used the dashboard: Workers & Pages → Queues →
    `pano-uploads-dlq-dev` → Messages → Send message, type JSON, body:
    ```json
    { "object": { "key": "panos/alert-test/alert-test/original" }, "action": "PutObject" }
    ```
    The key doesn't exist, so no marker was written (logged as skipped) and the message was acked.
    The email arrived with subject `[panote] tiling failed permanently (1) - pano-uploads-dlq-dev`,
    confirming the send path end to end on dev. Read via the Workers Observability
    *calculations* view grouped by `$metadata.message` (see the backlog/log check note above for
    why the *events* view doesn't work for this). If a future test doesn't arrive, check the
    Worker's logs for `failed to send DLQ alert` and its error code (`E_SENDER_NOT_VERIFIED`,
    `E_RECIPIENT_NOT_ALLOWED`, ...) or `skip DLQ alert`.
- **Still unexercised live.** Unit B4 added the marker-write code and its unit tests (mocked/miniflare
  R2, no real Cloudflare Queues); it does not change the fact recorded in "Known unverified areas"
  below that an actual retry-to-DLQ delivery has never been observed against real Cloudflare.
- **Multipart etag format unverified — and the app itself never triggers it.** The same-etag race
  check above compares against `t${TILER_OUTPUT_VERSION}-<etag>`, and a multipart upload's S3-style
  etag itself contains a `-N` suffix (part count) — `container.ts` already handles a hyphen in the
  etag (`derives the version from a multipart GET ETag containing a hyphen`, unit-tested), but that
  test constructs the etag by hand. `upload-api`'s `presignPut` (`packages/worker-kit/src/r2-s3.ts`)
  only ever presigns a single `PutObject`; the browser's `XMLHttpRequest PUT` against that URL is
  therefore never multipart, no matter the file size, so this path is never exercised by the app as
  built. Multipart only happens through an out-of-band writer that chooses to split the upload itself
  — an S3 multipart client (`CreateMultipartUpload`/`UploadPart`/`CompleteMultipartUpload`) against the
  same bucket, or `wrangler r2 object put --remote` with a large enough file. Verify the real `eTag`
  format deliberately, with one of those two, rather than waiting to see it from ordinary use.

---

## Monitoring and alerts

What alerts, and how. Until this existed the only alert was the DLQ email above; a Worker
answering `5xx`, a failed daily cron or a failed CDN purge only showed up in the logs.

### Health check (every 5 minutes)

`tiler-consumer` has a Cron Trigger, `*/5 * * * *`, that runs `runHealthCheck`
(`services/tiler-consumer/src/health.ts`). It lives there, not in a new Worker or in `admin-api`,
because `tiler-consumer` already has the `ALERT_EMAIL` binding, the `ALERT_EMAIL_TO` secret and a
sender on `panote.io`, the only domain with Email Routing: nothing new has to be set up for it
to email, on dev or production. It also keeps it out of `admin-api`'s cron, which another job
uses.

**Checks** (`src/health-probes.ts`):

| Check | How | Up when |
|---|---|---|
| `website /`, `website /explore` | `WEBSITE` service binding | `200` HTML |
| `website tour page` (only with `HEALTH_TOUR_SLUG` set) | `WEBSITE`, `/s/<slug>` | `200` HTML with the tour's boot data (`id="pn-boot"`), so the slug and bundle were read from R2 |
| `admin app /app/` | `ADMIN_APP` | `200` HTML |
| `public-api /api/explore` | `PUBLIC_API` | `200` JSON with a `tours` array |
| `admin-api /api/admin/panos`, `upload-api /api/upload-url` | `ADMIN_API`, `UPLOAD_API`, no token | `401`: the Worker ran and refused, it didn't `5xx` |
| `public URL /` (only with `HEALTH_PUBLIC_PROBES` `true`; off by default) | global `fetch` of `HEALTH_SITE_ORIGIN`, redirects not followed | `200` HTML, **or a redirect to `*.cloudflareaccess.com`** |
| `public URL /api/explore` (same) | global `fetch` | `200` JSON with `tours`. An Access redirect here is down: it means the `/api/*` bypass app is gone |
| `admin-api daily cron` | reads `ops/cron/admin-api-daily.json` | the last run had no task throw and the last clean run is under 26 h old |
| `cdn purge` | reads `ops/cdn-purge/last-failure.json` | no purge failed in the last hour |

Each probe has a 10 s timeout. Requests carry `user-agent: panote-health-check` and no token.

**Cloudflare Access on dev.** `panote.dev`'s pages are behind Access (Cloudflare Access (dev
only), above), so a public probe of a page gets a `302` to the login. The probes therefore go
through **service bindings**, straight into each Worker: that proves the Worker's code runs and
answers, and never meets Access or a route.

**Public URL probes: off by default** (`HEALTH_PUBLIC_PROBES` `false` in both env blocks). With
it `true`, two more probes fetch `HEALTH_SITE_ORIGIN` the way a visitor does, to catch a broken
route or Access setup, and count the Access login redirect as up for a page (production has no
Access, so there it's a plain `200`). They are off because a Worker's `fetch` to another
Worker's route on the same account has historically failed (error 1042 and same-zone requests
going to the origin instead), which would mean a false DOWN email after every deploy; the
service-binding probes already cover the Workers, and the external monitor (TODO below) covers
the public path. To try them: set `HEALTH_PUBLIC_PROBES` to `"true"` in the `dev` block of
`services/tiler-consumer/wrangler.jsonc`, run `pnpm --filter @service/tiler-consumer run types`
(it should report no change) and merge; then watch the logs for `[health] check failed check=public URL`
over the next 15 minutes. If those lines appear while the service-binding checks pass, set it
back to `"false"`; a DOWN email for them may already have gone out.

**When it emails.** A check is down after **2 failures in a row** (`FAILURES_TO_ALERT`) and up
again after one pass. An email goes out whenever the set of down checks differs from what the
last email said, at most **one per 30 minutes** (`ALERT_THROTTLE_MS`, shared with the DLQ alert,
separate window): subject `[panote] <host> DOWN (N): <checks>` with each check's status, or
`[panote] <host> recovered: all checks pass`. A flap that ends where the last email left it, inside
the window, sends nothing; one that doesn't is sent when the window closes, as things stand then.
A failed send is retried on the next run. With `ALERT_EMAIL_TO` unset it logs
`[health] skip alert` and sends nothing, like the DLQ alert. There is no reminder while something
stays down.

**State** is one small object, `ops/health/state.json` in the content bucket
(`{ failures, announced, lastSentAt, cronMissingSince }`), written only when it changes. Like the
DLQ throttle it sits under `ops/`, which the CDN never serves. If it can't be read the check
starts from scratch, which can mean one email too many, never none.

**Logs.** Every failing check, every run: `[health] check failed check=<name> detail=<status>`.
Also `[health] alert sent`, `[health] alert throttled`, `[health] failed to send alert: code=…`.
Details are statuses and error names only.

**Vars** (both env blocks of `services/tiler-consumer/wrangler.jsonc`):
`HEALTH_SITE_ORIGIN` (`https://panote.dev` / `https://panote.io`), `HEALTH_TOUR_SLUG` (empty: no
tour page probe; set it to a published Unlisted or Public tour that should stay up) and
`HEALTH_PUBLIC_PROBES` (`false`, see above). After changing one, run
`pnpm --filter @service/tiler-consumer run types` and commit any `env.d.ts` change (a value
change alone leaves it as it is; CI checks for drift).

### Daily cron and CDN purge failures

- **Daily cron.** `admin-api`'s `scheduled` handler runs its tasks (`slug-aliases`,
  `account-deletions` with its CDN purge, `tile-gc`, `trash`, `plan-sweep` with its CDN purge)
  through `runDailyCron`
  (`services/admin-api/src/cron-status.ts`). Each task that throws logs
  `[cron] daily task failed task=<name> error=<error name>`, and every run writes
  `ops/cron/admin-api-daily.json`: `{ lastRunAt, lastOkAt, failed }`, where `lastOkAt` only moves
  on a run with no task failed. The health check fails `admin-api daily cron` when the last run
  failed or the last clean run is over 26 h old (the cron stopped). A failed run keeps the check
  failing until the next daily run comes back clean, so even a one-off failure means a DOWN email
  and the recovery email about a day later; the alert says so ("clears after the next successful
  daily run"). On
  a bucket with no status yet, it waits 26 h from the first time it saw that before failing. A
  task's per-item failures that it logs and carries on from (one account, one tile version) don't
  count: only a task that throws.
- **CDN purge.** A failed purge already logs `cdn purge failed (…)`. It now also overwrites
  `ops/cdn-purge/last-failure.json` (`{ at, detail }`, the same status and error codes as the log
  line), from both request handlers and the crons, after its in-request retries. The `cdn purge`
  check fails for an hour after the latest one, so a failure emails (twice-in-a-row rule: from
  about 5 minutes after) and recovers on its own. A burst of deletes past the Free plan's 5 prefix
  purges a minute (`429`) alerts too; those purges are queued and retried every 15 minutes (CDN
  purge on delete), and each retry that still fails records the marker again, so the check keeps
  failing until the queue drains. A skipped purge (token or zone id
  not configured, production today) records nothing.

### Not covered

- **A Cloudflare-wide outage.** Every check runs inside Cloudflare; if Cloudflare, or Workers
  Cron Triggers, are down, nothing runs and nothing emails.
- `5xx` on routes nothing probes (an editor save, a like). Those show in Workers Logs and the
  error reports (Error reporting), not here.
- The tiler container and the upload queue: dead letters still alert through the DLQ email.
- `cdn.panote.dev`/`cdn.panote.io` themselves (R2 custom domain), unless the tour page probe is set.

**TODO (Joel): add an external uptime monitor.** Set up a free monitor from any external uptime
service (one that checks from outside Cloudflare) on `https://panote.io/` and
`https://panote.io/api/explore` once production is up, alerting to the same inbox. It's the only
thing that sees a Cloudflare-wide outage or a DNS problem with `panote.io`. Not for `panote.dev`:
Access would make its pages look down. Nothing has been signed up for.

**Status: code only, not deployed.** After the next dev deploy: check `tiler-consumer`'s logs for
`[health]` lines (none expected while everything passes), and after the next 03:17 UTC run, for
`ops/cron/admin-api-daily.json` in `pano-content-dev`. To see an alert end to end, set
`HEALTH_TOUR_SLUG` on dev to a slug that doesn't exist and deploy: the tour page check fails, and
an email arrives about 10 minutes later; set it back and the recovery follows within 30 minutes.

---

## Operator pages

`/app/ops` in the admin app is the operator area: metrics and, later, support tools. It is for
signed-in Auth0 users listed in `admin-api`'s `OPERATOR_SUB_SHA256` var (both env blocks of
`services/admin-api/wrangler.jsonc`): the hex SHA-256 of each operator's Auth0 user id,
comma-separated. Empty, the default, means nobody. Every other signed-in user gets the same `404`
from every `/api/admin/ops` route as from a route that doesn't exist (`requireOperator` in
`src/ops-gate.ts`; signed out, it's the usual `401`), and "Page not found" at `/app/ops`; `GET /api/admin/account` says `operator: true` only for a listed user, and the
account page (`/app/account`) links to Operations from that. These routes are separate from the
token-guarded `/api/admin/operator/*` routes the scripts call.

The list holds hashes so the repo never names anyone's Auth0 user. Adding an operator
(**Needs you**): find the user id (Auth0 dashboard → User Management → Users → the user →
`user_id`, e.g. `google-oauth2|1234`; for a linked account, the primary one), then

```bash
printf %s 'google-oauth2|1234' | sha256sum
```

and add the 64-hex hash to `OPERATOR_SUB_SHA256` for that env, in a PR. It takes effect on the
next deploy. Removing one is the same edit the other way.

---

## Insights (unit B5)

`public-api` writes one Workers Analytics Engine data point per viewer event (`view`, `scene`,
`hotspot`, `dwell`) to its `EVENTS` binding. `admin-api` reads them back through the AE SQL API
for `GET /api/admin/tours/:tourId/insights`. The event schema and privacy rules are in
`docs/wave6-plan.md` section 3.3: content ids only, no IP, UA, country, referrer, client id or sub.

- **Datasets.** `panote_events_dev` / `panote_events`. AE creates a dataset the first time a
  Worker writes to it, so there is no provisioning command; the first `POST .../view` after
  deploying `public-api` creates it. AE keeps data for three months (Cloudflare's limit, not
  configurable). **Status: deployed to dev** — an owner `GET .../insights` returned `200` in dev
  in the week to 2026-10-07 (admin-api logs); the dataset's contents weren't checked.
- **Secret.** `admin-api` needs a custom API token whose only permission is **Account → Account
  Analytics → Read**, with Account Resources limited to the panote account. Cloudflare's AE SQL
  API docs create it under My Profile → API Tokens → Create Token → Create Custom Token (a user
  token). An account-owned token (Manage Account → Account API Tokens) lists Account Analytics as
  supported and would survive user changes, but the AE docs don't mention it, so it is untested.
  Put whichever you create into the secret:
  ```bash
  pnpm --filter @service/admin-api exec wrangler secret put CF_ANALYTICS_TOKEN --env dev
  ```
  Repeat with `--env production` once production is provisioned. Until it's set, the insights
  route returns `502 { error: 'analytics unavailable' }` (the rest of `admin-api` is unaffected).
  **Status: set for dev, outstanding for production.**
- **Vars.** `CF_ACCOUNT_ID` (`12e2809e05de8a2bf20b815fd394ec9a`) and `AE_DATASET` are plain vars
  in both `admin-api` env blocks; `AE_DATASET` must match `public-api`'s `EVENTS` dataset for the
  same env. Nothing to do beyond deploying.
- **Limits and cache.** Each owner gets 30 Insights requests a minute (`INSIGHTS_LIMITER`, on
  top of the read limit; see Rate limits). A full answer is kept in the Cache API of the
  Cloudflare location for 60 s (`INSIGHTS_CACHE_SECONDS`), one entry per tour and `days`, so
  refreshing doesn't run the 4 SQL queries again: new views show up within a minute or so, on top
  of AE's own ingestion delay. The key holds the owner too (a SHA-256 of the sub), and the
  route checks the caller owns the tour before it reads the cache; a `502` is never cached. The browser still gets `private, no-store`.
- **Smoke test (dev).** After both Workers deploy and the secret is set, open a tour a few times,
  wait a minute or two for AE ingestion, then `GET /api/admin/tours/<tourId>/insights` as the
  owner and check `daily` shows today's views. The same token can run ad-hoc queries against
  the SQL API directly; `SHOW TABLES` lists the datasets.

---

## Error reporting

Both SPAs report uncaught errors and unhandled promise rejections to `public-api`'s
`POST /api/errors` (`installErrorReporter` in `packages/web-kit/src/error-reporter.ts`, set up in
each app's `main.tsx`). No third-party service. The report (`ClientErrorReportSchema` in
`@internal/contracts`) is `app`, `release` (the build's entry chunk hash, `local` on a dev server),
`kind`, `message` (≤300 chars), `stack` (top 5 frames, ≤200 chars each) and `path` (pathname
only, ≤120 chars). Nothing identifies the visitor: no user, client id, query string, fragment or
full page URL. Before sending, the reporter scrubs the message, frames and path
(`scrubErrorText`). In each whitespace-free token it finds where a URL starts, even glued to a
prefix (`url=https://...`, `[https://...`, `src=/api/x?...`): `scheme://` or a `data:`/`blob:` URL
anywhere, a `/` at the token start or right after `=` `:` `,` `[`, an IPv4 address or `localhost`
followed by an optional port and `/`, or a `host.tld` at the token start or after one of those
characters. It drops everything from the first `?` or `#` after that point to the end of the
token, keeping a frame's trailing `:line:col`; the token is never split at `=` or `,`, so later
query values go too. A `?` in plain prose ("valid? no") is kept, and so is the query of a URL
with none of those shapes (e.g. `api/x?y`, with no leading `/`). It masks emails as `<email>`
(also `%40`-encoded, and with non-ASCII or punycode domains), the user and password of
`scheme://user:pass@host` as `<userinfo>`, anything after `Bearer ` as `<token>`, JWTs (`eyJ...`)
as `<jwt>`, and the value of `code=`, `state=`, `nonce=`, `password=`, `sig=`, `signature=`,
`x-amz-*=`, `token=`, `secret=` and any `*_token=` / `*_secret=` pair wherever it appears (a
fragment, a form body) as `<redacted>`. In R2 keys and CDN URLs it masks the owner segment after
`panos/`, `tours/`, `accounts/` and `upload-log/` as `:owner`, pano ids after `tiles/` and
`tile-gc/` as `:panoId`, tour ids after `pub/tours/`, `pub/plans/`, `tour-owners/`,
`explore/tours/` and `explore/hidden/` as `:tourId`, and slugs after `slugs/` as `:slug`. In page
and API paths it masks slugs as `/s/:slug`, tour ids as `/api/tours/:tourId`,
`/api/admin/tours/:tourId` and `/app/t/:tourId`, and pano ids as `/api/admin/panos/:panoId` (any
case). Any remaining UUID (pano and tour ids, a visitor's like id) becomes `<id>`. The scrub is
linear in the text, and its tests time adversarial inputs of ~100k characters. The
reporter slices each field to 4× its cap before scrubbing and drops the token that slice cut
through (back to the last whitespace, if any), so half an email can't get past the mask. `public-api` validates
the shape, scrubs again and re-caps each field, since masking can lengthen it.

- **Volume.** A page load reports at all with probability 1 off production and 0.25 in production
  (`errorSampleRate`), decided once per load; it sends at most 5 reports, never the same error
  twice, and ignores `Script error.`, ResizeObserver loop notices and errors whose top frame is a
  browser extension. On the server, `ERRORS_LIMITER` (20/min per client IP, see Rate limits).
- **Same origin only.** A request whose `Sec-Fetch-Site` is present and not `same-origin`, or whose
  `Origin` is present and not the request's own origin, gets `403 {"error":"cross-origin"}`,
  before the limiter. Non-browser clients send neither header and are let through. So a local
  Vite dev server (`localhost:5173`/`5174`, proxying `/api` to `panote.dev`) has its reports
  refused: its `Origin` is localhost.
- **Transport.** `sendBeacon` with a text body, else a `keepalive` `fetch` without cookies, the
  same helper as the viewer analytics. The reporter never throws and never reports its own errors.
- **CSP.** The endpoint is same-origin (`VITE_API_BASE` is empty), which `connect-src 'self'`
  already allows in both apps. An absolute `VITE_API_BASE` is added to `connect-src` too, but if
  it is on another origin every report gets a `403` from the same-origin check above.
- **Reading them.** Each valid report is one `console.error` object in `public-api`'s Workers Logs,
  `{ event: "client-error", app, release, kind, message, stack, path }`: filter on
  `event = client-error`. Nothing is stored anywhere else. The client IP is only the limiter's key.
  Reports are unauthenticated, so anyone can forge one or send noise (within the limit): treat them
  as hints to go and reproduce, never as proof of what a visitor saw.
- **Not covered.** Errors a React Router `errorElement` catches never reach `window`, so they are
  not reported.

---

## Production runbook

**Status: unprovisioned.** `panote.io` is an Active Cloudflare zone (since 2026-09-26, see DNS /
zone setup) with Email Routing and no web records. Every `production` env block in every
`wrangler.jsonc` is declared but nothing behind it exists: no bucket, queues, notification, CORS,
`cdn.panote.io`, WAF or cache rules, secrets, or Auth0 tenant. The `production` GitHub Environment
is the one piece already done (a required reviewer, a main-only branch policy and
`CLOUDFLARE_API_TOKEN`, see GitHub setup).

`deploy.yml` refuses a production deploy until the repository variable `PRODUCTION_PROVISIONED`
is the literal `true`, and fails on any `YOUR_` placeholder left in a `production` env block or an
`apps/*/.env.production`. Nothing else checks that the account is ready: the variable is set by
hand, so it means only what this runbook says it means. Run the steps **in order**. Several depend
on the one before, and step 4 must be done before step 6, or the private keys under `panos/` and
`tours/` become public the moment the domain attaches. Each step links to the section that
explains it; the dev version of every step has been done and is recorded there.

Steps 1-7 are one `pulumi up --stack production` now (`infra/README.md`, step 10): bucket,
queues, notification, CORS, WAF rules (with URL normalization), cache rules, `cdn.panote.io`, and
the apex and `www` records with the redirect. Their **Verify** lines still apply. The manual
commands stay below as the fallback.

All commands run from the repo root. CI already dry-runs every Worker with `--env production`
(`deploy-dry-run` in `ci.yml`), so the production config bundles; what it can't check is whether
the account has the resources the config names.

1. **Bucket and queues.** Create `pano-content`, `pano-uploads` and `pano-uploads-dlq` (commands
   in Bucket + queues).
   Verify: `wrangler r2 bucket list` shows `pano-content`, `wrangler queues list` both queues.
   **Status: outstanding.**

2. **R2 → queue notification.** Prefix `panos/`, suffix `/original` → `pano-uploads` (command in
   R2 → queue notification). Run it once: check
   `wrangler r2 bucket notification list pano-content` first.
   Verify: the list shows exactly one rule, object-create, `panos/` / `/original`, queue
   `pano-uploads`.
   **Status: outstanding.**

3. **Bucket CORS.** `infra/r2/cors.json` on `pano-content`, never `cors.dev.json` (Bucket CORS).
   Verify: `wrangler r2 bucket cors list pano-content` shows origins `https://panote.dev` and
   `https://panote.io` only, no `localhost`.
   **Status: outstanding.**

4. **WAF custom rule for `cdn.panote.io`, before step 6.** On the `panote.io` zone, Security →
   Security rules → custom rule, action **Block**, the expression from "Prerequisite: WAF custom
   rule" with the host changed:
   ```
   (http.host eq "cdn.panote.io" and not (starts_with(http.request.uri.path, "/tiles/") or starts_with(http.request.uri.path, "/pub/") or starts_with(http.request.uri.path, "/slugs/")))
   ```
   Also check Rules → Settings → URL normalization is on for the zone (it is what makes
   `/tiles/../panos/` hit the rule).
   Verify: the rule is listed, **enabled**, action Block, host `cdn.panote.io` (not
   `cdn.panote.dev`, an easy copy-paste miss). It can't be curled until step 6; step 6 does that
   first thing.
   **Status: outstanding.**

5. **Cache rules.** `infra/cloudflare/cache-rules.production.json`, applied by Pulumi. It
   manages two rules: `panote-json-edge-cache`, as on dev, and `panote-tiles-404-no-store` (a
   tile `404` is never edge-cached). It sets only the `404` TTL, not `cache`, and leaves out
   `manifest.json`, so the manifest stays `DYNAMIC` (see Known limitations). Manual fallback:
   the dashboard's Rules → Cache Rules, mirroring the file.
   Verify: the `panote.io` zone's Rules → Cache Rules lists both, enabled. Their effect is
   checked in the final block.
   **Status: outstanding.**

6. **Attach `cdn.panote.io` to `pano-content`** (Attaching the domain; dashboard, or
   `wrangler r2 bucket domain add pano-content --domain cdn.panote.io --zone-id <panote.io zone id>`).
   Only once step 4's rule is enabled.
   Verify, straight away, while the bucket is still empty:
   - `curl -sI https://cdn.panote.io/panos/x`, `/tours/x`, `/accounts/x`, `/backup/x`, `/trash/x`, `/` and
     `/tiles/../panos/x` (that one with `curl --path-as-is`, or curl collapses the `..` itself):
     all `403`.
   - `curl -sI https://cdn.panote.io/tiles/x`: `404` from R2, not `403`.
   If any private path isn't `403`, detach the domain before doing anything else.
   **Status: outstanding.**

7. **Web DNS records and the `www` redirect.** On `panote.io`: a proxied `AAAA @ 100::` (the
   same placeholder dev has; the Workers' routes serve it), and a proxied `AAAA www 100::` with a
   Redirect Rule (Rules → Redirect Rules → single redirect): hostname equals `www.panote.io` →
   dynamic `concat("https://panote.io", http.request.uri.path)`, `301`, preserve query string.
   Don't touch the MX, SPF or DKIM records (Email). Never add the dev zone's noindex Transform
   Rule (Search engines) or Cloudflare Access (Cloudflare Access) to this zone.
   Verify: `dig +short AAAA panote.io` and `www.panote.io` return Cloudflare addresses;
   `curl -sI 'https://www.panote.io/privacy?x=1'` is `301` to `https://panote.io/privacy?x=1`.
   The apex itself answers with a Cloudflare error page until step 12 deploys.
   **Status: outstanding.**

8. **Production Auth0 tenant.** A new tenant (not `panote-dev`), with:
   - an API, identifier `https://api.panote.io` (must match `OAUTH_AUDIENCE` and
     `VITE_AUTH0_AUDIENCE`), offline access allowed;
   - a Single Page Application: callback `https://panote.io/app/callback`, logout URLs
     `https://panote.io/` and `https://panote.io/app/`, allowed web origin `https://panote.io`,
     refresh-token rotation on (the dev settings are in Sign-in, unit C3; production has no
     `localhost` entries);
   - the `google-oauth2` connection with **its own Google OAuth client**, not Auth0's dev keys
     (those are for testing only, and Google's consent screen would name Auth0, not panote). In Google Cloud: an OAuth
     consent screen for panote with the `panote.io` domain and the privacy and terms URLs
     (`https://panote.io/privacy`, `/terms`), published to production; a Web client with
     authorized redirect URI `https://<tenant domain>/login/callback`. Put its client id and
     secret into the Auth0 connection and enable the connection for the SPA only. No other
     connection is enabled (`VITE_AUTH0_CONNECTIONS=google-oauth2`).
   Verify: `curl -s https://<tenant domain>/.well-known/openid-configuration | jq -r .issuer`
   prints the issuer URL step 10 will use, trailing slash included.
   **Status: outstanding.**

9. **Secrets.** All with `--env production` (Secrets, CDN purge on delete, Insights, Takedown,
   Tiling failure marker and alerting):
   - `upload-api` and `tiler-consumer`: `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, from a new R2
     API token with Object Read & Write scoped to `pano-content` only (not dev's token).
   - `tiler-consumer`: `ALERT_EMAIL_TO`, byte-identical to a verified Email Routing destination.
   - `admin-api`: `CF_ANALYTICS_TOKEN` (Account Analytics Read), `CF_PURGE_TOKEN` (Zone → Cache
     Purge, scoped to `panote.io`), `OPERATOR_TOKEN` (a new `openssl rand -hex 32`, not dev's).
   A Worker that has never been deployed doesn't exist yet: `wrangler secret put` then offers to
   create an empty Worker of that name, and saying yes is fine, since step 12's deploy replaces
   it (not tried on this account yet).
   Verify: `wrangler secret list --env production` in each of the three services lists the names
   above.
   **Status: outstanding.**

10. **Replace every `YOUR_` placeholder, in one PR.** `OAUTH_ISSUER` in the `production` block of
    `services/{admin-api,public-api,upload-api}/wrangler.jsonc` (the step 8 issuer, the whole URL:
    the tenant may be regional, `https://<name>.<region>.auth0.com/`); `CDN_ZONE_ID` in
    `services/admin-api/wrangler.jsonc`; `VITE_AUTH0_DOMAIN` and `VITE_AUTH0_CLIENT_ID` in
    `apps/website/.env.production` and `apps/admin/.env.production` (the SPA's client id is
    public). `CDN_ZONE_ID` is `pulumi stack output zoneId --stack production`. Replace each only with the real value, never another made-up
    name (`docs/decisions.md`). Run `pnpm -r run types` and commit any `env.d.ts` change (CI fails
    on drift).
    Verify: this prints nothing (comment lines mention `YOUR_` and are skipped):
    ```bash
    grep -rn YOUR_ services/*/wrangler.jsonc apps/*/wrangler.jsonc apps/*/.env.production \
      | grep -vE '^[^:]+:[0-9]+:\s*(#|//)'
    ```
    CI's production dry-runs and production app build must pass too. Merging deploys dev
    only, as always.
    **Status: outstanding.**

11. **Rate limits and Analytics Engine: nothing to create.** The production `namespace_id`s
    (`2101`, `2201`–`2206`, `2301`–`2304`, Rate limits) are already in config and only have to be unique in the
    account; the `panote_events` dataset appears on the first write (Insights).
    Verify: `grep -rn namespace_id services/*/wrangler.jsonc` shows no id used twice.
    **Status: done in config.**

12. **Unlock and deploy.** Only now set the repository variable `PRODUCTION_PROVISIONED` to
    `true` (GitHub → Settings → Secrets and variables → Actions → Variables), then run Deploy with
    `workflow_dispatch`, environment `production`, from `main`, and approve it. The four Worker
    jobs and two app jobs run in parallel; `admin-api` binds `public-api`'s `TourStats` across
    scripts, so if `admin-api` fails on this first run because `panote-public-api` doesn't exist
    yet, re-run that one job once `public-api` is in. Likewise `tiler-consumer` has service
    bindings to the other five production Workers (Monitoring and alerts): if its job fails
    because one of them doesn't exist yet, re-run it once they are all in. The `smoke-test` job
    then checks the public URLs (below).
    Verify: every job green, `smoke-test` included.
    **Status: outstanding.**

13. **DLQ alert test.** As dev's Ops step 2 (Tiling failure marker and alerting), on
    `pano-uploads-dlq`: dashboard → Queues → `pano-uploads-dlq` → Send message, body
    `{ "object": { "key": "panos/alert-test/alert-test/original" }, "action": "PutObject" }`.
    Verify: an email `[panote] tiling failed permanently (1) - pano-uploads-dlq` arrives, and
    `tiler-consumer`'s logs show the marker skipped (the key doesn't exist).
    **Status: outstanding.**

14. **Health check.** Set `HEALTH_TOUR_SLUG` in the `production` block of
    `services/tiler-consumer/wrangler.jsonc` to a published tour's slug, and check the Worker's
    logs for `[health] check failed` (Monitoring and alerts). Set up the external uptime monitor
    for `panote.io` (same section, the TODO at the end).
    Verify: no `[health] check failed` line ten minutes after the deploy; the first daily cron
    after it writes `ops/cron/admin-api-daily.json`.
    **Status: outstanding.**

### Post-provision verification

Run after step 12, before telling anyone the site exists. The first group is what `deploy.yml`'s
`smoke-test` job checks on every production deploy; the rest needs a person.

```bash
# Private prefixes stay private (step 4): every line 403
for p in panos/x tours/x accounts/x ops/x explore/index/x backup/x trash/x '' tiles/../panos/x; do
  curl -sI --path-as-is -o /dev/null -w "%{http_code} /$p\n" "https://cdn.panote.io/$p"; done
# Public prefixes pass through to R2: 404 for a key that doesn't exist, not 403
curl -sI -o /dev/null -w '%{http_code}\n' https://cdn.panote.io/tiles/x/manifest.json
# APIs: 200 (no auth), 401, 401
curl -s -o /dev/null -w '%{http_code}\n' https://panote.io/api/tours/x/stats
curl -s -o /dev/null -w '%{http_code}\n' https://panote.io/api/explore
curl -s -o /dev/null -w '%{http_code}\n' https://panote.io/api/admin/panos
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://panote.io/api/upload-url
# Apps: 200, 200, 307 to /app/; indexable (no X-Robots-Tag), robots.txt says Allow: /
curl -sI https://panote.io/ | grep -iE '^(HTTP|x-robots-tag|content-security-policy)'
curl -sI https://panote.io/app/t/anything | head -1
curl -sI https://panote.io/app | grep -iE '^(HTTP|location)'
curl -s https://panote.io/robots.txt
```

Then, by hand:

- **Auth round trip.** Sign in with Google from `https://panote.io/?signin=1`: it lands on
  `/app/` signed in, Google's consent screen names panote (not Auth0), and sign-out returns to
  `https://panote.io/`. A `curl -H 'Authorization: Bearer x' https://panote.io/api/admin/panos`
  is `401` with `auth rejected` in `admin-api`'s logs and no placeholder-issuer line.
- **A test upload tiles.** Upload a pano in the admin: within a minute or two it shows as ready.
  `https://cdn.panote.io/tiles/<panoId>/manifest.json` is `200`, a tile is `200` with
  `cache-control: public, max-age=31536000, immutable` (`HIT` on the second fetch), and the
  original at `https://cdn.panote.io/panos/<owner>/<panoId>/original` is `403`.
- **Cache rules.** A tile URL that doesn't exist is `404` twice, never `HIT`, and the test pano's
  `tiles/<panoId>/manifest.json` still returns `cf-cache-status: DYNAMIC`. Publish a test tour:
  `https://cdn.panote.io/slugs/<slug>.json` is `HIT` on the second fetch; `/s/<slug>` on
  `panote.io` shows the tour and a Slack DM of the link unfurls with its image (Link previews).
- **Purge and delete.** Delete the test tour and pano (wait an hour after upload, the
  recent-upload guard): the tile and slug URLs come back `404` within a minute, and `admin-api`
  logs no `cdn purge failed` or `cdn purge skipped`.
- **DLQ alert**: step 13.

Anything that fails here: roll the Worker back (Rollback, below) or unset
`PRODUCTION_PROVISIONED` while it's fixed. A CDN privacy failure means detaching `cdn.panote.io`
first and asking questions after.

---

## Rollback

Every deploy makes a new Worker version, and the last 100 are kept. To put the previous one back
on a Worker without waiting for a fix to go through CI:

```bash
pnpm --filter @service/admin-api exec wrangler deployments list --env production   # what's live, and when it went out
pnpm --filter @service/admin-api exec wrangler versions list --env production      # the 10 most recent versions
pnpm --filter @service/admin-api exec wrangler rollback <version-id> --env production -m 'why'
```

Without a version id it rolls back to the version before the live one. The same works for every
Worker, the two app Workers included (a version carries its static assets), and for `--env dev`.
It only changes what serves traffic: the next deploy from `main` replaces it again, so revert the
bad commit on `main` too (on dev, merging the revert is the redeploy). Per Cloudflare's
rollback docs, it can't go back past a change to the Durable Object migrations. Bucket contents,
queues and the zone's cache and WAF rules are not part of a version and stay as they are; if a
secret changed since the target version, check `wrangler secret list` afterwards. For `tiler-consumer`, whether a rollback also brings back the previous container image
hasn't been checked; if the bad change is in the container, redeploy the last good commit instead.

---

## Known unverified areas

- **The container on real Cloudflare — now verified.** `services/tiler-consumer/Dockerfile`'s
  STATUS note (2026-08-12) covered only a Docker-on-x86_64 `sharp` round trip. The Wave 5
  end-to-end run (2026-09-26, see the first dev deploy checklist above) exercised the actual
  Queue-consumer-to-container `@cloudflare/containers` Durable Object lifecycle against real
  Cloudflare: the queue message reached the Tiler DO, the container tiled a real upload, and the
  manifest landed on the CDN.
- **arm64-host builds.** The Dockerfile pins `--platform=linux/amd64` on both stages because the
  only host it's been built on is x86_64; an arm64 host (e.g. Apple Silicon) build path is
  untested. Unaffected by the 2026-09-26 end-to-end run — that ran the already-built dev image.
- **The real R2 S3 path — now verified.** `packages/worker-kit/src/r2-s3.ts`'s tests
  (`r2-s3.test.ts`) still only check URL shape and signature presence, but the 2026-09-26
  end-to-end run exercised the real path both ends: `upload-api`'s presigned PUT (a 4096x2048
  JPEG, `200`) and the tiler container's S3 writes (tiles and manifest landing in
  `pano-content-dev`) both worked end-to-end.
- **Queue / Durable Object lifecycle — consumer swap and normal delivery now verified.** The
  2026-09-26 cut-over removed the old pano-viewer consumer and attached
  `panote-tiler-consumer-dev` with no messages in flight (the bucket was empty at the time), so
  behavior for a message in flight during the swap is untested. The end-to-end run's message
  afterward flowed through the queue to the Tiler DO and container without retry. Behavior under
  an actual retry or DLQ path (a failing tile job) has not been exercised and stays unverified —
  unit B4 (see "Tiling failure marker and alerting" above) adds the DLQ-consumer code and its unit
  tests, but not a live DLQ delivery.
- **The real JWKS success path — now verified.** `packages/worker-kit/src/auth.ts`'s tests still
  only exercise the `globalThis.__verifyJwt` test seam and the rejection path for a
  missing/placeholder issuer, but the 2026-09-26 end-to-end run fetched a real JWKS document from
  `https://panote-dev.au.auth0.com/` and verified a real Auth0-issued M2M token on
  `GET /api/admin/panos` (`200`).

---

## Known limitations

Found during the 2026-09-26 end-to-end run (see the first dev deploy checklist above), now that
the container, queue, JWKS, and S3 paths are actually exercised rather than theoretical:

- **Deleted tiles already in the CDN edge cache keep serving.** A tile that Cloudflare's edge had
  already cached kept returning `200` (`cf-cache-status: HIT`) after its pano was deleted, because
  tiles are `public, max-age=31536000, immutable` and nothing purges the edge cache on delete (see
  "Deleted panos" above for the existing note on this). True revocation needs a Cloudflare cache
  purge by URL or prefix — B6 adds a best-effort purge on delete, verified in dev on 2026-10-08
  (see "CDN purge on delete").
- **Hardened, verified in dev (2026-10-08): the presigned upload PUT pins content-type.**
  `presignPut` signs `content-type` alongside `host` (then `SignedHeaders=content-type;host`). Against
  one presigned URL for an `image/jpeg` upload, a PUT with `content-type: image/png` and one with
  no content-type both got `403` (`SignatureDoesNotMatch`) and wrote nothing; the same PUT with
  `image/jpeg` got `200`.
- **Signed but unverified: the single-use condition on upload URLs.** `upload-api` signs
  `If-None-Match: *` (new pano, plan image) or `If-Match: <ETag>` (replace) into each presigned
  PUT (Owner quotas, "Single-use upload URLs"). R2 supports both on `PutObject` (the tiler's
  manifest writes rely on `If-Match`), but a presigned PUT carrying them has not been tried in dev
  yet. To verify: get an upload URL, PUT the file with the response's `headers` → `200`; PUT the
  same request again → `412` and no second tiling job; PUT without the conditional header →
  `403`. For a replace, the second PUT should get `412` too (different bytes). Also unverified:
  that R2, like S3, checks `X-Amz-Expires` when a request starts rather than when its body has
  arrived; with the 120 s expiry, a 150 MiB upload over a link slower than about 10 Mbit/s would
  fail if R2 checked at the end. To check, start a large PUT (throttled, e.g.
  `curl --limit-rate`) just before its URL expires and see that it still gets `200`; if it
  doesn't, raise `UPLOAD_URL_EXPIRY_SECONDS` (the URLs are single-use either way).
- **Signed but unverified: the presigned upload PUT pins content-length.** On 2026-10-08, with
  content-length unsigned, a URL presigned for `size: 100` accepted an 8779-byte PUT with `200`.
  `upload-api` now also signs `content-length` as the declared `size`
  (`SignedHeaders=content-length;content-type;host`); the browser sends a `File`'s size as
  Content-Length itself, which is that `size`. Whether R2 checks a signed content-length on a
  presigned PUT has not been verified in dev yet: until a PUT of a different length is seen to get
  `403`, treat the 150 MiB size cap as enforced only at presign (input validation on the presign
  request in `upload-api`) and in the tiler, which backstops it with its own byte
  (`MAX_ORIGINAL_BYTES` var, `services/tiler-consumer/wrangler.jsonc:55,92`) and pixel
  (`packages/tiler/src/pyramid.ts:43`) caps. If R2 ignores it, uploads still work as before.
- **Fixed, live in dev (unit O1).** A tile 404 used to be edge-cached for 4h (`text/html`,
  `max-age=14400`). A Cache Rule `tiles-404-short-ttl` on the `cdn.panote.dev` zone now matches
  `starts_with(http.request.uri.path, "/tiles/")` and gives a 404 response a short/no-store edge
  TTL instead (plan: `docs/wave6-plan.md` section 3.5, unit O1), added via the dashboard (Rules →
  Cache Rules; not scriptable with wrangler). Pulumi replaces it with the equivalent
  `panote-tiles-404-no-store` (CDN cache rules). Verified live: a tile 404 returns
  `cf-cache-status: BYPASS`, an existing tile still `HIT`, and `manifest.json` is unaffected —
  still `DYNAMIC`, as it already was.
- **`manifest.json` isn't edge-cached.** It comes back `cf-cache-status: DYNAMIC` — Cloudflare
  doesn't cache `.json` by default — so its `cache-control: max-age=30` has no effect at the edge;
  every manifest fetch hits R2 directly. Correct behavior, just not what the `max-age` might
  suggest. It stays that way on purpose; `/slugs/` and `/pub/` get an edge cache rule once
  Pulumi applies `cache-rules.<env>.json` (CDN cache rules).
- **`wrangler r2 bucket info`'s `object_count` lags badly** — it reported `0` while the bucket
  held 32 objects. Don't rely on it for an emptiness check (see the pre-cut-over check's caveat
  above); probe specific keys with `wrangler r2 object get --remote` instead, since wrangler 4.120
  can't list bucket objects without S3 credentials.
- **Originals that never tiled aren't swept.** An original whose tiling dead-lettered (or that was
  abandoned before any config referenced it) stays until the owner deletes the pano. Sweeping them
  safely needs a scan of every owner's `panos/` prefix and a check that none of that owner's tours
  references the pano; that's a follow-up, not a daily job over the whole bucket.
- **Tour languages need admin-api deployed before the admin SPA, and an open editor reloaded.**
  The `languages`/`i18n` fields are optional and zod drops keys it doesn't know, so an admin-api
  from before tour languages accepts a translated tour or pano and stores it without its
  translations. An admin tab opened before the deploy does the same thing from the other side:
  its bundle has the old schemas, so a Save from it strips `i18n`. Deploy `admin-api` first, then
  the admin SPA, and expect editors open during the deploy to need a reload (a dev auto-deploy
  ships both together, so this mostly matters for production).
- **A pano's translations can outnumber one tour's languages.** A scene config is per pano and a
  pano can be in several tours, so its `i18n` maps take up to `MAX_CONFIG_TRANSLATION_LANGUAGES`
  (40) languages where a tour takes 10, and removing a language from a tour keeps the panos'
  strings for it (other tours may use them). Publish only sends the tour's own languages, and
  `MAX_SCENE_TRANSLATION_CHARS` bounds the size either way. Strings for a language no tour uses
  any more stay in the config until the author clears them field by field.
- **Account linking doesn't move data.** Sign-ins that share a verified email are joined into the
  oldest Auth0 user, but Panote data a newer user stored under its own sub before it was linked
  stays under that sub (see "Account linking" under Sign-in). Pre-launch there is none.
- **The DLQ alert email is throttled, not batched on a timer.** At most one email per queue per
  30 minutes; a burst sends the first email at once and counts the rest into the next one (see
  "Tiling failure marker and alerting"). If no failure follows the burst, the held count is never
  emailed: it stays in `ops/dlq-alert/<queue>.json` and the Worker logs until the next one.
