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
| `services/public-api` | `panote-public-api-dev` / `panote-public-api` | `panote.dev/api/tours/*` / `panote.io/api/tours/*` | `STATS` — Durable Object, class `TourStats`; `EVENTS` — Analytics Engine, dataset `panote_events_dev` / `panote_events` (unit B5) | none |
| `services/admin-api` | `panote-admin-api-dev` / `panote-admin-api` | `panote.dev/api/admin/*` / `panote.io/api/admin/*` | `BUCKET` — R2, bucket `pano-content-dev` / `pano-content`; `PUBLISHER` — Durable Object, class `TourPublisher` (one per tourId, serializes publish/slug/visibility/unpublish; migration `v1` `new_sqlite_classes`, applied by `wrangler deploy`); var `SLUG_ALIAS_DAYS` (`30`, days an old share-link slug keeps redirecting after a rename); daily Cron Trigger `17 3 * * *` that deletes expired slug aliases under `slugs/`; vars `CF_ACCOUNT_ID`, `AE_DATASET` (unit B5) | `CF_ANALYTICS_TOKEN` (unit B5, insights; R2 itself uses the native binding, not the S3 API) |
| `services/upload-api` | `panote-upload-api-dev` / `panote-upload-api` | `panote.dev/api/upload-url` / `panote.io/api/upload-url` | none (S3 API via `R2_ACCOUNT_ID`/`R2_BUCKET` vars) | `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` |
| `services/tiler-consumer` | `panote-tiler-consumer-dev` / `panote-tiler-consumer` | none — queue consumer, no `fetch` handler | `TILER` — container Durable Object, class `Tiler`; `BUCKET` — R2, bucket `pano-content-dev` / `pano-content` (unit B4: tile-failed marker); queue consumer on `pano-uploads-dev` / `pano-uploads` (`max_batch_size: 1`, `max_retries: 3`, dlq `pano-uploads-dlq-dev` / `pano-uploads-dlq`, `max_concurrency: 5`) and, as of unit B4, on the DLQ itself (`max_batch_size: 10`, `max_retries: 3`, `max_concurrency: 1`, no further DLQ — see below); `ALERT_EMAIL` — `send_email`, unrestricted, var `ALERT_EMAIL_FROM` = `tiler-alerts@panote.io` (DLQ alert email, see below) | `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` (forwarded into the container's `process.env` via `Container.envVars` — see `services/tiler-consumer/src/container-env.ts`); `ALERT_EMAIL_TO` (DLQ alert recipient, optional — unset means no email) |

All four: `observability.enabled: true` in both env blocks. `workers_dev` is `true` in `dev`
(the `*.workers.dev` URL stays reachable for smoke tests even once routes are live — see the
DNS section) and `false` in `production`. `dev`'s `OAUTH_ISSUER` now points at the real Auth0
tenant, `https://panote-dev.au.auth0.com/` (`OAUTH_AUDIENCE` `https://api.panote.dev`), provisioned
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
script that only runs for `/s/*` (slug redirects, below). Why not Pages, and why
build-time config: `docs/decisions.md`.

| App | Script (dev / production) | Route (dev / production) | Vite `base` / output |
|---|---|---|---|
| `apps/website` | `panote-website-dev` / `panote-website` | `panote.dev/*` / `panote.io/*` | `/` → `dist/` |
| `apps/admin` | `panote-admin-dev` / `panote-admin` | `panote.dev/app` + `panote.dev/app/*` / same on `panote.io` | `/app/` → `dist/app/` |

Both: `assets.not_found_handling: "single-page-application"`, `observability.enabled: true` in
both env blocks, `workers_dev` `true` in dev and `false` in production, no secrets. Admin has no
bindings; the website has `BUCKET` (R2, `pano-content-dev` / `pano-content`) and `ASSETS`.

**Route precedence.** The website's `panote.dev/*` overlaps every other route on the host.
Cloudflare resolves that by specificity: "When more than one route pattern could match a request
URL, the most specific route pattern wins" (Workers docs, [Routes → Matching
behavior](https://developers.cloudflare.com/workers/configuration/routing/routes/#matching-behavior),
with the example that `example.com/hello/*` takes precedence over `example.com/*`). So
`/api/admin/*`, `/api/tours/*` and `/api/upload-url` stay on the API Workers and `/app`, `/app/*`
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
reads `slugs/<slug>.json` through the `BUCKET` binding (it only ever reads that prefix; R2
bindings can't be scoped, so read-only is by convention). An unexpired `redirect` alias whose
target slug is still a live pointer to the **same** tourId gets a `308` to `/s/<new>` (or
`/s/<new>/embed`) with the query string kept and `Cache-Control: no-store`. Anything else (live
pointer, miss, expired alias, a target another tour holds, an invalid slug, an R2 error) falls
through to `env.ASSETS.fetch`, i.e. the SPA, which then shows the tour or its "This tour isn't
available" placeholder. `_headers` still applies to responses served through `env.ASSETS.fetch`
(checked under `wrangler dev`: CSP, `frame-ancestors` per path, nosniff). `wrangler types --env
dev` omits the inherited `ASSETS` binding, so `worker/assets.d.ts` declares it.
The `Location` is relative (`/s/<new-slug>`, query kept).
Post-deploy checks (dev; production the same on `panote.io`):
- `curl -sI https://panote.dev/s/<old-slug>` on a renamed tour: `308`,
  `Location: /s/<new-slug>`, `Cache-Control: no-store`.
- `curl -sI https://panote.dev/s/<live-slug>`: `200` with `frame-ancestors 'none'` in the CSP.
- `curl -sI https://panote.dev/s/<live-slug>/embed` (and `/embed/`): `200` with `frame-ancestors *`.
  These two confirm `_headers` still applies to responses that pass through the script.

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
`style-src 'self'`, `img-src 'self' <cdn> data: blob:`, `media-src 'self' <cdn>`, `connect-src 'self' <cdn> <auth0 domain>`
(admin adds the R2 S3 endpoint), `frame-src https://www.youtube-nocookie.com` (admin adds `'self'`),
`object-src 'none'`, `base-uri 'self'`, `form-action 'self'`, plus `nosniff` and
`strict-origin-when-cross-origin`. Every path gets `frame-ancestors 'none'` except the website's
`/s/:slug/embed`, whose rule removes the inherited CSP (`! Content-Security-Policy`) and sets
the same policy with `frame-ancestors *`. Verified under `wrangler dev`: the embed path gets only
the `*` policy, other paths only `'none'`, and SPA-fallback responses carry the headers too.
Vite's `assetsInlineLimit` is 0 so no asset turns into a `data:` URI that the CSP would block.
The embed rule is repeated for `/s/:slug/embed/` (trailing slash). Dev builds add
`X-Robots-Tag: noindex` on every path; production stays indexable.

CSP notes for the D units:

- The viewer's vanilla info-hotspots UI (`@panote/viewer/ui`) injects a `<style>` element, which
  `style-src 'self'` blocks. The apps don't use it: the React viewer chrome in `@internal/ui`
  (`styles/viewer.css`) replaces it. Inline `style` set from JS (CSSOM) is not affected.
- Hotspot media: video and images load only from `'self'` and the CDN (`media-src`/`img-src`),
  YouTube only via `www.youtube-nocookie.com` (`frame-src`). The public viewer renders media on any
  other host (or media that fails to load) as an "Open image/video ↗" link instead.
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
`deploy-dry-run` job dry-runs both apps with `--env dev`. The existing `CLOUDFLARE_API_TOKEN`
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

Production is unprovisioned, like the rest (see Production status).

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
production Auth0 tenant, no `PRODUCTION_PROVISIONED` repository variable — see Production status
below). The `production` GitHub Environment itself already exists, with a required reviewer and a
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

# production — outstanding, blocked on panote.io becoming a Cloudflare zone
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

# production — outstanding
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
# production, once the bucket exists:
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
for tour insights (see "Insights (unit B5)" below) and the optional `CF_PURGE_TOKEN` (see "CDN
purge on delete" below). `wrangler deploy --env <env> --secrets-file <file>` is the alternative to
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
`CF_PURGE_TOKEN` has been set on dev, so purges go live in dev with the next deploy (step 4 not yet
run). Production has no token and `CDN_ZONE_ID` is still `YOUR_PANOTE_IO_ZONE_ID`.

---

## DNS / zone setup

- **`panote.dev`** — **live on Cloudflare as of 2026-09-25**: nameservers `jo.ns.cloudflare.com`
  and `kaiser.ns.cloudflare.com`, zone Active, with the placeholder proxied `AAAA @ 100::` record
  in place; the website and admin Workers' routes will serve it after the first deploy (see Frontends). `admin-api`, `public-api`, and `upload-api`'s
  dev `routes` blocks all target `panote.dev`, and their first dev deploy (see the checklist
  below) already succeeded against it. `workers_dev: true` still gives a second, always-reachable
  `*.workers.dev` URL for smoke tests, independent of the route.
- **`panote.io`** — **moved from AWS Route 53 to Cloudflare on 2026-09-26**: same nameservers as
  `panote.dev` (`jo.ns.cloudflare.com` / `kaiser.ns.cloudflare.com`), set at the registrar
  (Namecheap), with the .io registry delegating to them at ~05:48 UTC. Zone is on the Free plan.
  No web records exist yet — no A/AAAA/CNAME — so there's nothing for a production route to
  attach to until production provisioning creates them. The old Route 53 zone carried
  `issue`/`issuewild "amazon.com"` CAA records left over from an abandoned ACM/CloudFront plan;
  they weren't carried over, and nothing Amazon-only should be added back to the Cloudflare
  zone — an Amazon-only CAA record would block Cloudflare from issuing its own certificate for
  the zone. This move clears the DNS blocker on production provisioning (see Production status
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
  once production provisioning (this whole doc, run with `production` in place of `dev`) is
  actually done. Until then, leave it unset or anything other than `true` — the
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
4. **Smoke test** (against the `*.workers.dev` URL, or the `panote.dev` route now that the zone
   is Active):
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
- **Alerting — email per dead-lettered batch.** After acking every message in a DLQ batch, the
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
  `ALERT_EMAIL_TO`, `ALERT_EMAIL_FROM` or binding logs a warning and skips. The main queue never sends. This uses the structured `send({ to, from, subject, text })`
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
  configurable). **Status: not yet deployed.**
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

## Production status

**Unprovisioned.** None of the following exist yet: `pano-content`, `pano-uploads`,
`pano-uploads-dlq`, the R2→queue notification, bucket CORS, the `cdn.panote.io` custom domain,
`R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY` secrets, the `CF_ANALYTICS_TOKEN` secret, or a production
Auth0 tenant. `panote.io`
became a Cloudflare zone on 2026-09-26 (see DNS section above), so that particular blocker on
the `routes` blocks each Worker's `wrangler.jsonc` already declares for `production` is cleared
— but the zone has no web records yet, so nothing is actually live, and every other piece of
production provisioning below is still outstanding. Every `production` env block in every
`wrangler.jsonc` is deliberately declared-but-unprovisioned — the config exists so Wave 5
doesn't have to reverse-engineer it, but none of it is live. Before a production deploy can
succeed: run every "outstanding" step in One-time provisioning above with `production` in place
of `dev`, provision the production Auth0 tenant, add the web DNS records on `panote.io`, replace
`admin-api`'s `YOUR_PANOTE_IO_ZONE_ID` (production deploys fail on any `YOUR_` placeholder until
then) and set its `CF_PURGE_TOKEN` (see "CDN purge on delete"), and —
only once all of that is actually done — set the repository variable `PRODUCTION_PROVISIONED` to
the literal string `true`. The `production` GitHub Environment itself is already provisioned (a
required reviewer, a main-only branch policy, and `CLOUDFLARE_API_TOKEN` — see GitHub setup
above); it's the resources and config underneath it that are missing. `deploy.yml`'s
`resolve-environment` job hard-stops any production deploy until that variable is `true` (see
GitHub setup above); it exists because nothing downstream can otherwise tell "provisioned" from
"not provisioned" on its own — `wrangler deploy` would just fail mid-matrix against whichever
resource happens to be missing for whichever service deploys first.

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
  purge by URL or prefix — B6 adds a best-effort purge on delete (see "CDN purge on delete" for
  its status).
- **Hardened (pending dev verification): the presigned upload PUT now pins content-type.**
  `presignPut` signs `content-type` alongside `host` (`SignedHeaders=content-type;host`), so a PUT
  with a different content-type *should* get `403` (`SignatureDoesNotMatch`), per R2's
  presigned-URL docs — not yet verified in dev, since B3's dev E2E is outstanding. **content-length
  is not signed, and R2 does not enforce it** — content-length isn't part of the signature, so a
  PUT with a body size different from what was presigned for still succeeds. The 150 MiB size cap
  is therefore enforced only at presign (input validation on the presign request in `upload-api`)
  and in the tiler, which backstops it with its own byte (`MAX_ORIGINAL_BYTES` var,
  `services/tiler-consumer/wrangler.jsonc:55,92`) and pixel (`packages/tiler/src/pyramid.ts:43`)
  caps.
- **Fixed, live in dev (unit O1).** A tile 404 used to be edge-cached for 4h (`text/html`,
  `max-age=14400`). A Cache Rule `tiles-404-short-ttl` on the `cdn.panote.dev` zone now matches
  `starts_with(http.request.uri.path, "/tiles/")` and gives a 404 response a short/no-store edge
  TTL instead (plan: `docs/wave6-plan.md` section 3.5, unit O1), added via the dashboard (Rules →
  Cache Rules; not scriptable with wrangler). Verified live: a tile 404 returns
  `cf-cache-status: BYPASS`, an existing tile still `HIT`, and `manifest.json` is unaffected —
  still `DYNAMIC`, as it already was.
- **`manifest.json` isn't edge-cached.** It comes back `cf-cache-status: DYNAMIC` — Cloudflare
  doesn't cache `.json` by default — so its `cache-control: max-age=30` has no effect at the edge;
  every manifest fetch hits R2 directly. Correct behavior, just not what the `max-age` might
  suggest.
- **`wrangler r2 bucket info`'s `object_count` lags badly** — it reported `0` while the bucket
  held 32 objects. Don't rely on it for an emptiness check (see the pre-cut-over check's caveat
  above); probe specific keys with `wrangler r2 object get --remote` instead, since wrangler 4.120
  can't list bucket objects without S3 credentials.
- **The DLQ alert email has no volume throttle** (follow-up): it sends one email per DLQ batch,
  so a burst of failures means a burst of emails.
