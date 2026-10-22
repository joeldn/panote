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
| `services/public-api` | `panote-public-api-dev` / `panote-public-api` | `panote.dev/api/tours/*` + `panote.dev/api/errors` / same on `panote.io` | `STATS` — Durable Object, class `TourStats`; `EVENTS` — Analytics Engine, dataset `panote_events_dev` / `panote_events` (unit B5) | none |
| `services/admin-api` | `panote-admin-api-dev` / `panote-admin-api` | `panote.dev/api/admin/*` / `panote.io/api/admin/*` | `BUCKET` — R2, bucket `pano-content-dev` / `pano-content`; `PUBLISHER` — Durable Object, class `TourPublisher` (one per tourId, serializes publish/slug/visibility/unpublish; migration `v1` `new_sqlite_classes`, applied by `wrangler deploy`); var `SLUG_ALIAS_DAYS` (`30`, days an old share-link slug keeps redirecting after a rename); `STATS` — cross-script Durable Object binding to `public-api`'s `TourStats` (`script_name` `panote-public-api-dev` / `panote-public-api`; account delete clears a tour's counts, see Account deletion); daily Cron Trigger `17 3 * * *` that deletes expired slug aliases under `slugs/` and sweeps accounts marked for deletion; vars `CF_ACCOUNT_ID`, `AE_DATASET` (unit B5) | `CF_ANALYTICS_TOKEN` (unit B5, insights; R2 itself uses the native binding, not the S3 API) |
| `services/upload-api` | `panote-upload-api-dev` / `panote-upload-api` | `panote.dev/api/upload-url` / `panote.io/api/upload-url` | none (S3 API via `R2_ACCOUNT_ID`/`R2_BUCKET` vars) | `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` |
| `services/tiler-consumer` | `panote-tiler-consumer-dev` / `panote-tiler-consumer` | none — queue consumer, no `fetch` handler | `TILER` — container Durable Object, class `Tiler`; `BUCKET` — R2, bucket `pano-content-dev` / `pano-content` (unit B4: tile-failed marker); queue consumer on `pano-uploads-dev` / `pano-uploads` (`max_batch_size: 1`, `max_retries: 3`, dlq `pano-uploads-dlq-dev` / `pano-uploads-dlq`, `max_concurrency: 5`) and, as of unit B4, on the DLQ itself (`max_batch_size: 10`, `max_retries: 3`, `max_concurrency: 1`, no further DLQ — see below); `ALERT_EMAIL` — `send_email`, unrestricted, var `ALERT_EMAIL_FROM` = `tiler-alerts@panote.io` (DLQ alert email, see below) | `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` (forwarded into the container's `process.env` via `Container.envVars` — see `services/tiler-consumer/src/container-env.ts`); `ALERT_EMAIL_TO` (DLQ alert recipient, optional — unset means no email) |

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
script that only runs for `/s/*` (slug redirects and tour page priming, below). Why not Pages, and why
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
`/api/admin/*`, `/api/tours/*`, `/api/errors` and `/api/upload-url` stay on the API Workers and `/app`, `/app/*`
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
(`<tour> · panote`), `<meta name="robots" content="noindex">` for an unlisted tour, a
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
`object-src 'none'`, `base-uri 'self'`, `form-action 'self'`, plus `nosniff` and
`strict-origin-when-cross-origin`. Every path gets `frame-ancestors 'none'` except the website's
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

**Zone-wide guard (MANUAL, dev zone only).** Covers everything the code doesn't: the API Workers,
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

**Sign-in (unit C3).** Auth0 SPA flow (Authorization Code + PKCE, `google-oauth2` only) with
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

**More sign-in providers (Apple, Microsoft, Facebook).** The apps know four connections
(`KNOWN_CONNECTIONS` in `packages/web-kit/src/config.ts`), shown in this order: Google
(`google-oauth2`), Apple (`apple`), Microsoft (`windowslive`), Facebook (`facebook`). A button is
shown only when its connection name is in `VITE_AUTH0_CONNECTIONS`, so today only Google shows.
Turning one on is an account task, done once per Auth0 tenant (dev now, production when its tenant
exists). Below, `<tenant>` is the tenant's domain (`panote-dev.au.auth0.com` for dev), and every
provider's redirect/return URL is `https://<tenant>/login/callback`.

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
   - **Facebook.** In Meta for Developers, create an app (use case *Authenticate and request data
     from users with Facebook Login*), add *Facebook Login*, set Valid OAuth Redirect URIs to
     `https://<tenant>/login/callback`. Under App settings → Basic set the privacy policy URL
     (`https://panote.dev/privacy`, `https://panote.io/privacy` for production) and the user data
     deletion instructions URL (the same page: it explains Delete account). Copy the App ID and
     App Secret, and switch the app to *Live*; only `public_profile` and `email` are needed.
2. **Add the Auth0 connection.** Auth0 dashboard → Authentication → Social → Create Connection →
   Apple / Microsoft Account / Facebook, and paste the credentials from step 1 (Apple: Services ID,
   Team ID, Key ID and the `.p8` contents; Microsoft: client id and secret; Facebook: App ID and
   secret). Request only basic profile and email. Check the connection's name is `apple`,
   `windowslive` or `facebook`: the apps send that exact name. Auth0 offers its own developer keys
   for some providers when the credential fields are left blank; they are for a quick try only
   (the consent screen names Auth0, not Panote, and they carry limits). Never leave a production
   connection on developer keys.
3. **Enable it for the SPA.** On the connection's Applications tab, turn on the tenant's SPA
   application (the one whose client id is `VITE_AUTH0_CLIENT_ID`). Use the connection's *Try*
   button to check a sign-in reaches the callback.
4. **Show the button.** Add the connection name to `VITE_AUTH0_CONNECTIONS` in both
   `apps/website/.env.<env>` and `apps/admin/.env.<env>` for that environment (comma-separated;
   order doesn't matter, the apps sort them), e.g.
   `VITE_AUTH0_CONNECTIONS=google-oauth2,apple,windowslive,facebook`, and ship that as a PR. Do
   this last: a button for a connection the tenant doesn't have fails at Auth0's `/authorize`.

Nothing on the API side changes. Workers only check the JWT, and owner keys are
`base64url(sub)`, so any sub prefix (`apple|…`, `windowslive|…`, `facebook|…`) works, as do
account deletion and the `delete-account.ts --sub` CLI. One Auth0 user per provider: someone who
signs in with Google once and Apple once has two separate Panote accounts unless the tenant links
them.

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
header, 24h preflight cache) and PUT (presigned uploads, `content-type` header, 1h preflight
cache), origins `https://panote.dev` and `https://panote.io`. This command always replaces the
whole ruleset (prompts for confirmation unless `--force`), so it's genuinely safe to re-run.

```bash
pnpm --filter @service/admin-api exec wrangler r2 bucket cors set pano-content-dev \
  --file ../../infra/r2/cors.json
# production, once the bucket exists (Production runbook, step 3):
pnpm --filter @service/admin-api exec wrangler r2 bucket cors set pano-content \
  --file ../../infra/r2/cors.json
```

**Status: set for dev, outstanding for production** — `pano-content-dev`'s CORS ruleset is set
from `infra/r2/cors.json`; `pano-content` doesn't exist yet. Rollback: this command always
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
below). It's a secret only to keep the owner's personal address out of the repo; it must be
byte-identical to a verified Email Routing destination address on the account — a Gmail `+tag`
variant counts as a *different* address, and a mismatch makes `send()` fail with
`E_RECIPIENT_NOT_ALLOWED`, since `panote.io` isn't onboarded to Email Sending and only verified
destinations are allowed. Unset, the consumer skips the email with a warning and everything else
works.

Repeat with `--env production` once production is provisioned. `public-api` needs no secrets.
`admin-api` reads R2 through the native binding, not the S3 API, but needs `CF_ANALYTICS_TOKEN`
for tour insights (see "Insights (unit B5)" below), the optional `CF_PURGE_TOKEN` (see "CDN
purge on delete" below) and the optional `OPERATOR_TOKEN` (see "Takedown" below; unset, the
operator route answers `404`). `wrangler deploy --env <env> --secrets-file <file>` is the alternative to
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
pano it removed into one prefix request (100 max each); unpublish purges `pub/tours/<tourId>.json`
and the removed `slugs/<slug>.json` by URL. It's best-effort: a non-2xx, a network error or the 5s
timeout is logged (`cdn purge failed …`, status and Cloudflare error codes only) and nothing is
retried. With the token unset or `CDN_ZONE_ID` not a real 32-hex id it logs
`cdn purge skipped` and does nothing. Free plan limits are per account: 5 prefix requests/min,
bucket 25, so a burst of single-pano deletes past that gets `429`s and those tiles stay cached
until their TTL. Dev and production share that one account-wide prefix-purge budget.

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

Cache Rules on the CDN zone live in `infra/cloudflare/cache-rules.<env>.json` and go live with
`infra/cloudflare/apply-cache-rules.sh <env>`. Cloudflare keeps all of a zone's cache rules in
one `http_request_cache_settings` entrypoint ruleset, and a PUT replaces all of it, so the script:

1. GETs the live entrypoint (a zone with no cache rules yet has none, which counts as empty),
2. keeps every rule the file doesn't manage exactly as it is (today `tiles-404-short-ttl`, which
   was made in the dashboard), and replaces or appends each managed rule by its `ref`,
3. prints a unified diff of live vs after, and
4. PUTs only with `--yes`. Without it, or with `--dry-run`, nothing is written (both flags
   together is an error). If nothing changed it says so and exits. Right before the PUT it reads
   the live rules again and stops without writing if they changed since the diff.

```bash
# Token: My Profile → API Tokens → Custom token, Zone → Cache Rules: Edit, scoped to panote.dev
# (Read is enough for --dry-run). Not the wrangler OAuth login.
export CF_API_TOKEN=...
infra/cloudflare/apply-cache-rules.sh dev --dry-run   # show the diff
infra/cloudflare/apply-cache-rules.sh dev --yes       # apply it
# Offline: diff against a saved GET response instead of the API
infra/cloudflare/apply-cache-rules.sh dev --dry-run --live-file saved.json
```

The managed rule today is `panote-json-edge-cache`: on `cdn.panote.dev`, `/slugs/*` and `/pub/*`
are eligible for cache with the edge TTL taken from the origin (`max-age=30` from the R2 binding
writes) and a `404` never stored. The staleness bound is the same 30s the browser cache already
has, and unpublish purges both URLs (CDN purge on delete, above). `manifest.json` is left out on
purpose: after an image replace, admin's `refreshManifestCache` only refreshes the browser's copy,
so an edge copy would keep the old manifest for up to 30s. The tour page primes the start
manifest anyway (Tour page priming, above).

**Status: written, not applied.** The dry run against the live dev ruleset (read 2026-10-10)
shows `tiles-404-short-ttl` kept and the one new rule appended. After applying, check:
- `curl -sI https://cdn.panote.dev/slugs/<live-slug>.json` twice: the second is
  `cf-cache-status: HIT`.
- `curl -sI https://cdn.panote.dev/slugs/no-such-slug.json`: `404`, never `HIT`.
- The same slug URL with `-H 'Origin: http://localhost:5174'` and then `-H 'Origin:
  https://panote.dev'` each gets its own origin back in `access-control-allow-origin` (a cached
  CORS header must not leak across origins; tiles already work this way).
- A tile 404 is still `BYPASS` and a manifest is still `DYNAMIC`.

Rollback: taking the rule out of the JSON doesn't remove it live, because the script only
upserts. Remove it in the dashboard (Rules → Cache Rules) instead.

Production has its own `cache-rules.production.json` (hosts `cdn.panote.io`), applied with
`apply-cache-rules.sh production` (Production runbook, step 5). It also manages the tile-404 rule
that dev keeps in the dashboard, as `panote-tiles-404-no-store`. Its `zoneId` is
`YOUR_PANOTE_IO_ZONE_ID` until then, and the script refuses any `zoneId` that isn't a 32-hex id.

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
`production` is additionally
hard-guarded to `main` — the `resolve-environment` job's "Guard production to main" step fails
the run with an `::error::` annotation if `github.ref` isn't `refs/heads/main` — hard-stops
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

- GitHub Environment `dev` (created automatically on first use if it doesn't exist yet).
- GitHub Environment `production`, with required reviewers configured and a
  deployment-branch policy restricted to `main` — the approval gate the workflow relies on. The
  `resolve-environment` job's "Guard production to main" step is a workflow-level backstop, not
  a substitute for this Environment protection rule.
- `CLOUDFLARE_API_TOKEN` as an environment secret on **both** `dev` and `production` (scoped
  separately per environment, even though today both would point at the same Cloudflare
  account). The token needs Workers Scripts, Workers Routes, Containers, Queues, and R2 edit
  permissions.
- `CLOUDFLARE_ACCOUNT_ID` as a repository variable (not per-environment — one account for both).
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
   both are retried until they either succeed or exhaust `max_retries` and dead-letter. A key that
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
`TILER_OUTPUT_VERSION` in `packages/tiler/src/version.ts`, deploy `tiler-consumer`, then
re-trigger each pano by re-putting its original (verify these flags against
`wrangler r2 object --help` before running):

```bash
pnpm --filter @service/admin-api exec wrangler r2 object get pano-content-dev/panos/<owner>/<pano-uuid>/original --file x --remote
pnpm --filter @service/admin-api exec wrangler r2 object put pano-content-dev/panos/<owner>/<pano-uuid>/original --file x --remote
```

Both need `--remote`, for the same reason as the end-to-end test above. Re-putting identical
bytes **without** a version bump yields the same ETag, so the derived version string
(`t<TILER_OUTPUT_VERSION>-<etag>`) is unchanged too — it re-tiles into the same version dir,
rewriting identical keys rather than creating a new one. Old version dirs are left in place after
a re-tile; cleaning them up is deferred to Wave 6.

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
(`panos/<owner>/<panoId>/deleting`, skipped if one is already there), deletes the original, sweeps
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

A presigned upload URL stays valid for up to 900 seconds after `upload-api` issues it, and can
still be used within that window to re-create a deleted pano's original — which re-tiles a pano
that now has no `config.json`. That isn't a leak of anything new, and the pano can simply be
deleted again. The replace-image path (`POST /api/upload-url` with `panoId`) has the same TOCTOU:
its ownership HEAD check runs once, at presign time, so a presign issued just before a DELETE can
still land up to 900s later and recreate the original after the delete completed. It stays
confined to the caller's own owner-scoped prefix either way, so the impact is the same as the
fresh-upload case above — the pano can simply be deleted again.

---

## Account deletion

An owner deletes their own account from the admin app's account menu ("Delete account", on the
dashboard and in the editor, behind a typed confirmation). That calls `DELETE /api/admin/account`
on `admin-api` with the body `{"confirm":"delete my account"}` (`ACCOUNT_DELETE_CONFIRMATION` in
`@internal/contracts`; any other body is a `400` and touches nothing). The code is
`services/admin-api/src/delete-account.ts`.

**Order, and why a retry finishes the job.**

1. A marker, `accounts/<owner>/deletion.json` (`{ v, sub, requestedAt, completedAt? }`), is
   written create-only. From then on every `admin-api` write route (`POST`/`PUT`/`PATCH`/`DELETE`
   under `/api/admin/*`, except the account route itself and the operator route) and `upload-api`'s
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
3. Each pano: the same `deletePano` as a single pano delete (tombstone, original, one sweep of
   `tiles/<panoId>/`, then the owner prefix). No reference or recent-upload checks: everything goes.
4. `completedAt` is stamped on the marker, and the response is `200 {"status":"deleted"}`.

If any step throws, the route still answers `202 {"status":"pending"}`: the account is already
read-only, and the daily sweep finishes it. Either way the admin app signs the owner out (and if
sign-out itself fails, sends them to the website rather than offering a retry). CDN purges
(tiles prefixes, bundles, slugs) are batched as for tour delete (see "CDN purge on delete"),
including for a partial run.

**Daily sweep.** The existing `17 3 * * *` Cron Trigger also works through every marker:

- Interrupted deletes (no `completedAt`) first, oldest request first, then finished ones.
- A finished account costs one `LIST` (`limit: 1`) per owner prefix; only if something turned up
  there (a presigned upload issued before the marker, valid for 900s) does it run the full delete
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
  and the privacy page promise exactly that.
- **Likes this user gave on other people's tours.** A signed-in like stores `liked:<sub>` in that
  tour's `TourStats`, and there's no index from a user to the tours they liked. The privacy page
  says so.
- **Analytics Engine events** for the deleted tours. They're keyed by tourId, hold nothing about
  the owner, and age out with AE's three-month retention (see Insights).
- **Redirect aliases a tour dropped before every alias was tracked** (`MAX_ALIASES` was 20 and
  older ones went untracked). They stop being followed once the tour's live slug is gone and the
  daily alias sweep removes them when they expire.
- **Copies already in a browser cache**, and edge copies if the purge isn't configured (see
  "Deleted panos").

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
| `admin-api` | `WRITE_LIMITER` | every `POST`/`PUT`/`PATCH`/`DELETE` under `/api/admin/*` except the operator route | owner (Auth0 sub), checked after the JWT, before any R2 read | 120/min | `1301` / `2301` |
| `public-api` | `VIEW_LIMITER` | `POST /api/tours/:id/view` | client IP (IPv6 per /64) | 30/min | `1201` / `2201` |
| `public-api` | `LIKE_LIMITER` | `POST /api/tours/:id/like` | client IP (IPv6 per /64) | 10/min | `1202` / `2202` |
| `public-api` | `EVENTS_LIMITER` | `POST /api/tours/:id/events` | client IP (IPv6 per /64) | 120/min | `1203` / `2203` |
| `public-api` | `ERRORS_LIMITER` | `POST /api/errors` | client IP (IPv6 per /64) | 20/min | `1204` / `2204` |

`namespace_id` is ours to pick, an integer unique within the Cloudflare account; there is nothing
to create first (Cloudflare docs, "Rate Limiting" binding, checked 2026-10-21). Two bindings with
the same id share counters, so every binding and every env has its own. The dashboard doesn't show
these limits: watch for `429`s in Workers Logs. To change a limit, edit `simple.limit` in both env
blocks; `period` may only be `10` or `60`, and if it changes, change the matching constant
(`UPLOAD_URL_RATE_PERIOD_SECONDS`, `RATE_PERIOD_SECONDS`, `WRITE_RATE_PERIOD_SECONDS`) too. The per-IP keys are coarse: an
office or a carrier NAT shares one IP, which is why those limits are well above what one browser
sends (a view per page load, an events beacon at most every 5s, a like per click). The IP is only
the limiter's key, held in Cloudflare's short-lived counters: nothing of ours stores it, and AE and
`TourStats` still never see it (the privacy rule in `docs/wave6-plan.md` holds). `admin-api`'s
120/min is one editor Save of a full tour in a burst (`MAX_TOUR_SCENES` = 100 configs, the tour,
the publish); people editing by hand stay far below it.

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
  bare republish still work. Unpublish (and so tour delete) releases the tour's aliases as well as
  its live slug. Brand, support and sign-in words are reserved (`RESERVED_SLUGS`, plus any slug
  starting `panote` or led by `login`/`signin`); a tour already live at a word reserved later keeps
  republishing at it.

### Likes

`POST /api/tours/:id/like` now refuses (`400 {"error":"invalid X-Client-Id"}`) an anonymous
`X-Client-Id` that isn't a lowercase v4 UUID (`CLIENT_ID_PATTERN` in `@internal/contracts`; the
website mints `crypto.randomUUID()` and replaces a stored id that doesn't match). A signed-in like
still dedupes by sub and ignores the header. It answers `404 {"error":"tour not found"}`, and
creates no Durable Object or key, unless the tour's public bundle `pub/tours/<tourId>.json` exists:
`public-api` has a read-only `BUCKET` binding to `pano-content(-dev)` for that one `HEAD`. Inside
`TourStats`, one tour keeps at most `MAX_LIKES_PER_TOUR` (100,000) `liked:<who>` keys; past that a
new liker is neither counted nor stored, so storage per tour is bounded. Views and stats reads
don't check the bundle (a view stores one counter per tourId); the per-IP limit is their brake.

### Owner quotas

`upload-api` calls `checkQuota` (`src/quota.ts`) last before it signs an upload URL, after the
auth, rate limit, body checks and the account markers. Two optional vars:

- `MAX_PANOS_PER_OWNER`: most panos (directories under `panos/<owner>/`) one owner may hold. A
  replace doesn't count as a new pano.
- `MAX_BYTES_PER_OWNER`: most bytes of originals one owner may hold, counting the declared `size`
  of the upload; a replace frees the old original's bytes.

Unset or empty means unlimited, and costs nothing: the owner's prefix is only listed (S3
`ListObjectsV2`, one Class A operation per 1,000 objects) when a limit is set. That listing is a
known cost: with a limit on, it runs in full on every upload-URL request. A pano with a delete
tombstone (`deleting`) counts toward neither limit. Over a limit:
`403 {"error":"pano limit reached"}` or `403 {"error":"storage limit reached"}`. A listing that
fails is a `502`, and a value that isn't a non-negative integer refuses every upload (`500`), so a
typo can't silently lift the limit. It is a soft cap: it counts what's stored now and the declared
size, so concurrent requests can each pass, and the uploaded file can differ from the declared
size (up to the 150 MiB cap). To turn a limit on, add it to `vars` in both env blocks of
`services/upload-api/wrangler.jsonc`, delete its optional line from `src/env.d.ts`, run
`pnpm --filter @service/upload-api run types` and deploy.

### Report link

The visitor viewer (`/s/<slug>`, not the embed) has a **Report** chip at the end of the tour bar
(a flag only, on a phone). It's a `mailto:hello@panote.io` with the subject "Report a tour" and the
tour's share link in the body. Reports arrive at the Email Routing address like any other mail; act
on them with the takedown script below.

### Takedown

Two ways to stop abuse, usually together:

- **Take a tour down.** admin-api's operator-only route `POST /api/admin/operator/takedown`
  (`{ sub, tourId, action: "unpublish" | "delete" }`, header `X-Operator-Token`) runs exactly what
  the owner's own unpublish or tour delete runs, through the tour's `TourPublisher`, with the CDN
  purge. `unpublish` removes the share link, bundle and slug and keeps the tour and panos; `delete`
  also deletes the tour and every pano no other tour of that owner uses. It answers `404` for a
  missing or wrong token, and always while the `OPERATOR_TOKEN` secret isn't set on that env, so
  the route doesn't exist until you set it. It skips the write gate (no Auth0 user).
- **Disable the owner.** A marker `accounts/<owner>/disabled.json` (`{ v, disabledAt, reason? }`).
  While it exists every `admin-api` write and `upload-api`'s upload URL answer
  `403 {"error":"account disabled"}` (one more R2 `HEAD` each, in parallel with the deletion
  marker's, failing closed); reads still work, and so does the owner's own account delete. A
  deleted account answers `410` first. The account-deletion sweep never touches it, so it outlives
  an account delete and the same sign-in stays blocked. Removing it re-enables the owner. It
  doesn't take anything down by itself.

`services/admin-api/scripts/takedown.ts` does both. It runs like the account-delete script: Node 24
straight from TypeScript, a built workspace, the same R2 S3 credentials, and the same rule that
anything but a `-dev` bucket is named twice with `--allow-bucket`. Tour actions also need
`OPERATOR_TOKEN` (the same value as the `admin-api` secret) and call `https://panote.dev` for
`pano-content-dev` and `https://panote.io` for `pano-content`. `ADMIN_API_ORIGIN` overrides that,
but any origin other than the bucket's default also needs `--allow-bucket <bucket>`, so a dev
bucket can't quietly be sent to production's admin-api.

```bash
export R2_ACCOUNT_ID=... R2_BUCKET=pano-content-dev R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=...
export OPERATOR_TOKEN=...    # only for --unpublish / --delete
# Report only: which tour the share link is, who owns it, whether they're disabled
node services/admin-api/scripts/takedown.ts --slug old-town
# What it would do, without doing it
node services/admin-api/scripts/takedown.ts --slug old-town --unpublish --disable-owner --dry-run
# Take the tour down and block its owner, noting why (never shown to the owner)
node services/admin-api/scripts/takedown.ts --slug old-town --unpublish --disable-owner --reason 'report 2026-10-21'
# Or delete it outright; --tour takes a tourId instead of a slug
node services/admin-api/scripts/takedown.ts --tour <tourId> --delete
# An owner alone, by Auth0 user id
node services/admin-api/scripts/takedown.ts --sub 'google-oauth2|1234' --disable-owner
node services/admin-api/scripts/takedown.ts --sub 'google-oauth2|1234' --enable-owner
```

`--dry-run` writes nothing and calls no admin-api route, but it still makes the read-only R2
requests above (the slug `GET`, the owner scan, the marker `GET`/`HEAD`), so it needs the same R2
credentials and shows up in R2 request metrics.

Finding the owner: tour keys carry the owner and `pub/` deliberately doesn't, so with only a slug or
tourId the script lists `tours/` and `HEAD`s that tourId under each owner (one request per owner).
Pass `--sub` as well to skip that scan; the script then checks that this sub really holds the tour
(its `tour.json` or `publish.json`) and stops before writing anything if not, so a mistyped sub
can't disable someone else. A slug that is now a redirect alias still names its tour.
The owner is disabled before the tour comes down, so they can't republish in between. Both steps
are idempotent: rerunning is harmless, and disabling again only rewrites `disabledAt`/`reason`.

Setup, once per environment: generate a long random token (`openssl rand -hex 32`), then
`pnpm --filter @service/admin-api exec wrangler secret put OPERATOR_TOKEN --env dev` (and
`--env production`). Keep it with the R2 credentials; rotate it by putting a new value.

---

## Tiling failure marker and alerting (unit B4)

- **Marker key:** `panos/<owner>/<panoId>/tile-failed`, body `{ reason, at, originalEtag }` — same
  owner-scoped shape as `configKey`/`deletingKey` (`packages/contracts/src/keys.ts`'s `tileFailedKey`,
  for a caller with the raw owner sub, and `tileFailedKeyFromOriginalKey`, for the consumer, which
  only has the already-encoded owner segment from the R2 notification key and must not re-encode
  it). `reason` is one of `'dlq' | 'oversize' | 'unprocessable-key'`. `originalEtag` is the R2
  `etag` (bare, native-binding form) of the original the failure was about — the read side (A2)
  must treat a marker whose `originalEtag` doesn't match the *current* original's etag as stale
  and ignore it (a later, different upload superseded the failed one). `reason` and `originalEtag`
  are also written as R2 `customMetadata` on the same object (review fix, 2026-09-26), so A2's list
  endpoint can read both off `bucket.list({ include: ['customMetadata'] })` with no extra GET — the
  same pattern the plan already uses for config/tour summaries (section 3.1).
- **Written by** `services/tiler-consumer/src/consumer.ts` on three permanent-failure paths: a
  dead-lettered message (the Worker now also consumes `pano-uploads-dlq[-dev]` itself, branching on
  `batch.queue` against an exact set of the two real DLQ names, not a substring test), an oversized
  original, and a key `deriveUploadTarget` rejects. A charset-invalid key (bad owner or panoId) now
  gets no marker at all — `tileFailedKeyFromOriginalKey` validates both segments and the write is
  skipped with a log line, rather than writing a marker keyed on a junk panoId.
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
  Failures held back by the throttle are only emailed when a later batch arrives after the window:
  there is no timer that flushes them on its own. This uses the structured `send({ to, from, subject, text })`
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
with none of those shapes (e.g. `api/x?y`, with no leading `/`). It masks emails as `<email>`, tour
slugs as `/s/:slug` and `/slugs/:slug`, and tour ids as `/pub/tours/:tourId`, `/api/tours/:tourId`,
`/api/admin/tours/:tourId` and `/app/t/:tourId` (any case). The scrub is linear in the text. The
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

5. **Cache rules.** In your local checkout, put the `panote.io` zone id (Overview → API → Zone
   ID) into `infra/cloudflare/cache-rules.production.json` in place of `YOUR_PANOTE_IO_ZONE_ID`
   (the script refuses the placeholder), then
   `infra/cloudflare/apply-cache-rules.sh production --dry-run` and `--yes` (CDN cache rules; the
   token is scoped to `panote.io` this time). Production's file manages two rules:
   `panote-json-edge-cache`, as on dev, and `panote-tiles-404-no-store`, which does what dev's
   dashboard-made `tiles-404-short-ttl` does (a tile `404` is never edge-cached), so production
   needs no dashboard rule. It sets only the `404` TTL, not `cache`, and leaves out
   `manifest.json`, so the manifest stays `DYNAMIC` (see Known limitations). Keep the zone id
   edit uncommitted for now: step 10 commits it with the other placeholders.
   Verify: the dry run on an empty zone shows only the two rules being added; after `--yes` the
   script prints both as `enabled=true`. Their effect is checked in the final block.
   **Status: outstanding.**

6. **Attach `cdn.panote.io` to `pano-content`** (Attaching the domain; dashboard, or
   `wrangler r2 bucket domain add pano-content --domain cdn.panote.io --zone-id <panote.io zone id>`).
   Only once step 4's rule is enabled.
   Verify, straight away, while the bucket is still empty:
   - `curl -sI https://cdn.panote.io/panos/x`, `/tours/x`, `/accounts/x`, `/` and
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
    public); and step 5's zone id. Replace each only with the real value, never another made-up
    name (`docs/decisions.md`). Run `pnpm -r run types` and commit any `env.d.ts` change (CI fails
    on drift).
    Verify: this prints nothing (comment lines mention `YOUR_` and are skipped):
    ```bash
    grep -rn YOUR_ services/*/wrangler.jsonc apps/*/wrangler.jsonc apps/*/.env.production infra/cloudflare \
      | grep -vE '^[^:]+:[0-9]+:\s*(#|//)'
    ```
    CI's production dry-runs and production app build must pass too. Merging deploys dev
    only, as always.
    **Status: outstanding.**

11. **Rate limits and Analytics Engine: nothing to create.** The production `namespace_id`s
    (`2101`, `2201`–`2204`, Rate limits) are already in config and only have to be unique in the
    account; the `panote_events` dataset appears on the first write (Insights).
    Verify: `grep -rn namespace_id services/*/wrangler.jsonc` shows no id used twice.
    **Status: done in config.**

12. **Unlock and deploy.** Only now set the repository variable `PRODUCTION_PROVISIONED` to
    `true` (GitHub → Settings → Secrets and variables → Actions → Variables), then run Deploy with
    `workflow_dispatch`, environment `production`, from `main`, and approve it. The four Worker
    jobs and two app jobs run in parallel; `admin-api` binds `public-api`'s `TourStats` across
    scripts, so if `admin-api` fails on this first run because `panote-public-api` doesn't exist
    yet, re-run that one job once `public-api` is in. The `smoke-test` job then checks the public
    URLs (below).
    Verify: every job green, `smoke-test` included.
    **Status: outstanding.**

13. **DLQ alert test.** As dev's Ops step 2 (Tiling failure marker and alerting), on
    `pano-uploads-dlq`: dashboard → Queues → `pano-uploads-dlq` → Send message, body
    `{ "object": { "key": "panos/alert-test/alert-test/original" }, "action": "PutObject" }`.
    Verify: an email `[panote] tiling failed permanently (1) - pano-uploads-dlq` arrives, and
    `tiler-consumer`'s logs show the marker skipped (the key doesn't exist).
    **Status: outstanding.**

### Post-provision verification

Run after step 12, before telling anyone the site exists. The first group is what `deploy.yml`'s
`smoke-test` job checks on every production deploy; the rest needs a person.

```bash
# Private prefixes stay private (step 4): every line 403
for p in panos/x tours/x accounts/x ops/x '' tiles/../panos/x; do
  curl -sI --path-as-is -o /dev/null -w "%{http_code} /$p\n" "https://cdn.panote.io/$p"; done
# Public prefixes pass through to R2: 404 for a key that doesn't exist, not 403
curl -sI -o /dev/null -w '%{http_code}\n' https://cdn.panote.io/tiles/x/manifest.json
# APIs: 200 (no auth), 401, 401
curl -s -o /dev/null -w '%{http_code}\n' https://panote.io/api/tours/x/stats
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
  `presignPut` signs `content-type` alongside `host` (`SignedHeaders=content-type;host`). Against
  one presigned URL for an `image/jpeg` upload, a PUT with `content-type: image/png` and one with
  no content-type both got `403` (`SignatureDoesNotMatch`) and wrote nothing; the same PUT with
  `image/jpeg` got `200`. **content-length is not signed, and R2 does not enforce it** — also
  checked 2026-10-08: a URL presigned for `size: 100` accepted an 8779-byte PUT with `200`. The
  150 MiB size cap is therefore enforced only at presign (input validation on the presign request
  in `upload-api`) and in the tiler, which backstops it with its own byte (`MAX_ORIGINAL_BYTES`
  var, `services/tiler-consumer/wrangler.jsonc:55,92`) and pixel
  (`packages/tiler/src/pyramid.ts:43`) caps.
- **Fixed, live in dev (unit O1).** A tile 404 used to be edge-cached for 4h (`text/html`,
  `max-age=14400`). A Cache Rule `tiles-404-short-ttl` on the `cdn.panote.dev` zone now matches
  `starts_with(http.request.uri.path, "/tiles/")` and gives a 404 response a short/no-store edge
  TTL instead (plan: `docs/wave6-plan.md` section 3.5, unit O1), added via the dashboard (Rules →
  Cache Rules; not scriptable with wrangler). `apply-cache-rules.sh` carries it over unchanged
  (CDN cache rules). Verified live: a tile 404 returns
  `cf-cache-status: BYPASS`, an existing tile still `HIT`, and `manifest.json` is unaffected —
  still `DYNAMIC`, as it already was.
- **`manifest.json` isn't edge-cached.** It comes back `cf-cache-status: DYNAMIC` — Cloudflare
  doesn't cache `.json` by default — so its `cache-control: max-age=30` has no effect at the edge;
  every manifest fetch hits R2 directly. Correct behavior, just not what the `max-age` might
  suggest. It stays that way on purpose; `/slugs/` and `/pub/` get an edge cache rule once
  `apply-cache-rules.sh` runs (CDN cache rules).
- **`wrangler r2 bucket info`'s `object_count` lags badly** — it reported `0` while the bucket
  held 32 objects. Don't rely on it for an emptiness check (see the pre-cut-over check's caveat
  above); probe specific keys with `wrangler r2 object get --remote` instead, since wrangler 4.120
  can't list bucket objects without S3 credentials.
- **The DLQ alert email is throttled, not batched on a timer.** At most one email per queue per
  30 minutes; a burst sends the first email at once and counts the rest into the next one (see
  "Tiling failure marker and alerting"). If no failure follows the burst, the held count is never
  emailed: it stays in `ops/dlq-alert/<queue>.json` and the Worker logs until the next one.
