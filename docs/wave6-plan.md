# Wave 6 plan: website + admin apps and the backend they need

Status: draft for review. Nothing here is implemented. Baseline: `main` at `8d3ab26`.
All `file:line` citations are against that commit.

---

## 1. Summary and key decisions

Wave 6 adds two React 19 + Vite + TypeScript SPAs (`apps/website`, `apps/admin`), two shared frontend
packages, and the backend changes the design needs: owner read routes, share links, analytics, and
a few pieces of hardening that the upload/delete UI makes visible to users.

| # | Decision | Rejected alternatives (brief) |
|---|---|---|
| D1 | **Host both SPAs on Workers Static Assets, not Pages.** Two assets-only Workers, `panote-website[-dev]` on route `panote.dev/*` and `panote-admin[-dev]` on route `panote.dev/app*` (mirrored on `panote.io`). The three API Workers keep their existing, more specific routes (`/api/admin/*`, `/api/tours/*`, `/api/upload-url`), and "more specific routes take precedence over wildcard routes" (Cloudflare routing docs), so all five Workers share one host with one routing mechanism, and the same-origin/no-CORS decision (`docs/decisions.md:27`) still holds. SPA fallback via `assets.not_found_handling: "single-page-application"`. Deploys use the same `wrangler deploy --env` path as the Workers (`.github/workflows/deploy.yml:236-241`), so it needs no new CI tooling, token type or deploy concept. | **Pages**: a second deploy system (`wrangler pages deploy`, separate project/branch model, custom-domain attachment for the apex that sits alongside the three Worker routes on the same host). Cloudflare now steers new projects to Workers static assets. **Workers Custom Domain for the apex**: that would work (routes run before a Custom Domain origin), but it replaces the existing placeholder `AAAA @ 100::` record (`docs/deploy.md:207-209`) and mixes two routing mechanisms. **Admin on `app.panote.dev`**: breaks same-origin, so it needs CORS on every API and on the bucket (`infra/r2/cors.json:5,13`) plus a cross-origin auth session. **One Worker serving both apps**: the brief asks for two apps, and separate Workers deploy and roll back independently. |
| D2 | **Admin lives at `/app/`** (Vite `base: '/app/'`) on the same origin as the website. That lets the Auth0 session be shared (website sign-in modal → `/app/`), and the owner-only "Edit" on the public viewer can call `admin-api`. | Subdomain (see D1). |
| D3 | **Auth: `@auth0/auth0-spa-js`, Authorization Code + PKCE, `audience` set to the existing `OAUTH_AUDIENCE`, refresh-token rotation, `cacheLocation: 'localstorage'`.** The Workers verify only RS256 JWTs whose `aud` includes `OAUTH_AUDIENCE` (`packages/contracts/src/jwt.ts:47-49,93`; `services/admin-api/wrangler.jsonc:21-22`). Without `audience`, Auth0 issues an opaque token that every route would 401. Social buttons call `loginWithRedirect({ authorizationParams: { connection } })` directly, so the modal's buttons are the whole UI (design README:79). | Hand-rolled PKCE (more code for no benefit). In-memory cache only: this loses the session on every reload and doesn't share it across the two apps, and silent auth via third-party cookies is unreliable in Safari. The localStorage exposure to XSS is mitigated with a strict CSP (section 5). |
| D4 | **Owner reads go through new `admin-api` GET routes (Bearer), never through the CDN.** The CDN stays public-prefix-only (`/tiles/`, `/pub/`, `/slugs/`, `docs/deploy.md:150`). | Loosening the WAF rule, or signing CDN URLs. Either one would expose `panos/<owner>/…` keys, which contain the reversible `base64url(sub)` (`docs/decisions.md:30`). |
| D5 | **List endpoints avoid N+1 GETs by writing summary fields into R2 `customMetadata` at write time** and reading them back with `bucket.list({ include: ['customMetadata'] })` (supported: `packages/worker-kit/src/worker-configuration.d.ts:1993-2000`). | A per-owner index object (needs a read-modify-write on every save, which races). N parallel GETs (the N+1 that `docs/decisions.md:14` calls out). |
| D6 | **Publish state lives in a private sidecar `tours/<owner>/<tourId>/publish.json`, not in `tour.json`.** If slug or visibility sat in `tour.json`, changing them from the share modal or the dashboard chip would bump the tour ETag and make the open editor's next Save 412 for no reason. | Adding `slug`/`visibility` to `TourDocSchema`. |
| D7 | **Public reads are one bundled document per tour** at `pub/tours/<tourId>.json` (tour + every scene's config), resolved from `slugs/<slug>.json`. The public viewer makes 2 JSON fetches, then manifests and tiles. Publish is explicit and idempotent: the editor calls it after each successful Save. | Per-scene `pub/panos/<panoId>/config.json` (N fetches, and a pano shared across tours would need a reverse index). Server-side auto-republish on every PUT (needs a config→tours reverse index). |
| D8 | **Analytics: Workers Analytics Engine for time series (views/day, dwell, per-pano, hotspot opens). The `TourStats` DO stays the all-time views/likes counter.** Ingest lives on `public-api` (anonymous). Queries run in `admin-api` over the AE SQL API with an account API token secret, behind a tour-ownership check. | Moving counters into AE (AE retention is bounded, so it can't give all-time totals). Querying AE from the browser (would leak the token). D1/DO-based rollups (more code, and AE already does it). |
| D9 | **Type-safe client = zod response schemas added to `@internal/contracts` plus a thin hand-written fetch client** in a new `@internal/web-kit`. | Hono RPC `hc<AppType>` (mentioned in `docs/decisions.md:14`). `admin-api` registers routes imperatively (`services/admin-api/src/index.ts:19-80`), not as one chained expression, so `AppType` wouldn't carry route types without a rewrite, and the apps would then type-depend on a `@service/*` package. The row in `decisions.md:14` gets updated to say so. |
| D10 | **Two shared packages:** `@internal/ui` (design tokens on `:root`, fonts, primitives, modals, share modal, viewer chrome, React `PanoStage` wrapper around `PanoViewer`) and `@internal/web-kit` (env config, auth, API client, `TourDoc`+configs → viewer `Tour` adapter, analytics beacon, upload/poll state machine). Neither is `@panote/*`: nothing here is meant to be published. | One package (it would mix React and non-React code, which makes the non-UI logic harder to unit-test). Copying code between the two apps. |
| D11 | **Per-environment frontend config is build-time Vite env files committed per app** (`.env.dev`, `.env.production`). Builds run `vite build --mode <env>`, and the production `YOUR_` placeholder guard (`.github/workflows/deploy.yml:143-193`) is extended to scan them. | A runtime `/config.json` served by a Worker (an extra request on boot, and it forces the apps to have a Worker script). |
| D12 | **Hotspot/view angles are radians (yaw/pitch) and degrees (fov), as in the viewer** (`packages/viewer/src/types.ts:3-7`, `ui/info-hotspots.ts:6-7`). The contract gets that documented and bounded. The prototype's normalised `yaw01/pitch01` is not carried over. | Normalised 0..1 storage (would mean converting at every viewer boundary). |

Scope boundary. **In Wave 6:** the items above, plus presign hardening, DLQ/failure marker, CDN purge
on delete, the tile-404 cache rule, the flaky tiler test, and viewer compass/mini-map/auto-rotate.
**Deferred:** multi-language `i18n` (decided, Q4 — Wave 7), per-pano likes (tour likes stay; the design
shows counts only), discovery listing for "Public", media *uploads* (only media URLs), old tile
version-dir cleanup and the bulk re-tile script (`docs/decisions.md:30`, `docs/deploy.md:480-481`),
OG/social preview tags on `/s/<slug>` (unit W3, optional).

---

## 2. Where the design / API brief conflicts with the code

The code wins unless noted. "Design README" = `docs/design/README.md`.

| # | Design / brief says | Code says | Resolution |
|---|---|---|---|
| C1 | Flat routes `GET /api/panos`, `PUT /api/panos/:id/config`, `POST /api/tours`, `PUT /api/tours/:id` (`API_BRIEF.md:17-21`, design README:29-33) | Admin routes are `/api/admin/panos`, `/api/admin/panos/:panoId/config`, `/api/admin/panos/:panoId`, `/api/admin/tours`, `/api/admin/tours/:tourId` (`services/admin-api/src/index.ts:19,27,43,54,66`). Public ones are `/api/tours/:tourId/{view,like,stats}` (`services/public-api/src/index.ts:15,19,32`) | Use the code's paths. New admin routes stay under `/api/admin/*`, and new public ones go under `/api/tours/*` (`docs/decisions.md:24`). |
| C2 | "There is deliberately no get config/tour API" — the editor/viewer read `config.json`/`tour.json` from the CDN (`API_BRIEF.md:9-10,26`; design README:23,38) | Configs/tours live under owner-scoped `panos/<owner>/<panoId>/config.json` and `tours/<owner>/<tourId>/tour.json` (`packages/contracts/src/keys.ts:39,44-45`), which the CDN WAF blocks (`docs/deploy.md:150`) | New owner `GET` routes (section 3.1). Public reads use the `pub/`/`slugs/` copies (section 3.2). |
| C3 | Poll `{cdn}/{panoId}/manifest.json` (`API_BRIEF.md:39`; design README:101) | Manifest is at `tiles/<panoId>/manifest.json` (`packages/contracts/src/keys.ts:53`). The viewer's `baseUrl` must be `https://cdn.panote.dev/tiles/` (`docs/deploy.md:431`; `packages/core/src/manifest.ts:39-41`) | Poll `${CDN_BASE}tiles/<panoId>/manifest.json`. |
| C4 | `GET /api/panos` returns IDs only; the gallery needs titles/thumbs/counts (`API_BRIEF.md:17,42-44`) | Same shape today: `{ panoIds }` (`services/admin-api/src/index.ts:19-25`). No tour list route exists (only `POST`/`PUT` tours, `index.ts:54,66`) | Add `GET /api/admin/tours` (the dashboard is tour-centric, screen 02). Extend `GET /api/admin/panos` additively (`panoIds` kept, `panos[]` added). |
| C5 | Dev has no `cdn.panote.dev` (`API_BRIEF.md:50`; design README:57) | Live in dev with the WAF rule (`docs/deploy.md:180-182`). `docs/decisions.md:17` still says "not provisioned yet" (stale) | Per-env `VITE_CDN_BASE`. Fix `decisions.md:17` in unit C2. |
| C6 | Stack "Cloudflare Pages + Vite" (design README:13). Repo docs say apps are Pages SPAs (`README.md:15-17`, `docs/STANDARDS.md:89`, `docs/decisions.md:9,12,24`, `packages/typescript-config/react.json:3`) | `apps/` does not exist (`ls apps` → no such directory). `README.md:17` lists an `apps/demo` that doesn't exist either | Workers static assets (D1). Rewrite those rows in place per the decisions-doc convention (`docs/decisions.md:3`). Drop `apps/demo` from `README.md` or mark it as not built. |
| C7 | Points stored as `yaw01/pitch01` (design README:167) | Contract `Hotspot.yaw/pitch` are unitless `z.number()` (`packages/contracts/src/schema.ts:18-19`). The viewer uses radians (`packages/viewer/src/types.ts:4-5`, `ui/info-hotspots.ts:6-7`) | Radians (D12). Document the units and add bounds in the schema (unit B1). |
| C8 | Connections as `links{ sceneId: [{to, yaw01}] }` (design README:167) | Contract models links as `type: 'link'` hotspots with `targetPanoId` (`schema.ts:14-30`). The viewer's nav-arrows want `Tour { start, scenes: Record<id, {initialView, links:[{to,yaw}]}> }` (`packages/viewer/src/ui/tour.ts:3-15`, `ui/nav-arrows.ts:31`) | Keep link hotspots as storage. `@internal/web-kit` adapts `TourDoc` + configs → viewer `Tour`. |
| C9 | North offset, point icon/size, media embeds, tour-wide control/map/compass, entry scene (design README:51,113-114) | Absent. Worse, `SceneConfigSchema`/`TourDocSchema` are plain `z.object` (default strip), so the current `PUT` would **silently drop** these fields (`schema.ts:36-42,54-58`; parse at `services/admin-api/src/index.ts:29,68`) | Additive optional schema fields (unit B1) before the editor ships them. |
| C10 | Upload copy "JPG, PNG, up to 200MP" (screen 03) | Decode cap `MAX_INPUT_PIXELS = 150_000_000` (`packages/tiler/src/pyramid.ts:43`). Byte cap 150 MiB (`services/tiler-consumer/src/consumer.ts:39`, `wrangler.jsonc:55`) | Copy says "up to 150MP". The client pre-checks the pixel count (decode the header) and the byte size before requesting a presign. |
| C11 | Landing CTA "free — no sign-up, live in seconds" (design README:68) and "Upload your first tour" drop target | `upload-api` authenticates every request (`services/upload-api/src/index.ts:12`). There is no anonymous upload | Decided (**Q1**): copy changes to "free — sign in with Google, live in seconds"; uploads stay authenticated, no anonymous uploads. The drop target stashes the `File` in IndexedDB, runs sign-in, then resumes the upload in `/app/`. |
| C12 | Sign-in modal offers Google, Apple, Facebook (prototype `Panote.dc.html`, "Continue with …") | Only Google social is enabled in the dev tenant (`docs/design/NOTES.md`, "Auth") | Decided (**Q2**): Google-only sign-in in Wave 6; Apple/Facebook buttons are hidden. Buttons are driven by config, so any connection that isn't enabled is simply not rendered. |
| C13 | Per-pano likes and views (design README:55,119) | Likes/views are per tour (`services/public-api/src/index.ts:13-30`; `stats.ts:5-8`) | Keep per-tour likes. Per-pano *views* come from AE (section 3.3). Per-pano likes are deferred. |
| C14 | Insights: 14-day series, avg time, most-opened points (design README:143-145) | Stats are only `{ views, likes }` (`services/public-api/src/stats.ts:5-8,31`) | AE (section 3.3). |
| C15 | Save flow: "on 428 re-fetch and retry" (design README:172) | 428 only means the client sent no `If-Match` (`services/admin-api/src/conditional.ts:8-10`) | The client always sends `If-Match`. A 428 is a client bug and is reported, not retried. A 412 opens the conflict state. |
| C16 | "Current" badge on the active card (design README:83); the screenshot shows "EDITING" | No backend concept | README wins (it's authoritative over screenshots, design README:212). "Current" = the last tour opened in the editor, from `localStorage`. |
| C17 | Embed/link host hardcoded `panote.io` (design README:127,134) | Per-env hosts (`README.md:57-64`) | `VITE_SITE_ORIGIN` (`https://panote.dev` / `https://panote.io`). |
| C18 | Public/Unlisted visibility, custom slug (design README:56,127-128) | No field, no slug store. `pub/` and `slugs/` are allowed by the WAF but nothing writes them (`grep -rn "pub/\|slugs"` over `services/` and `packages/` finds nothing; `docs/design/NOTES.md` item 2) | Section 3.2. |
| C19 | Brief says "CRUD worker" is one Worker | Split into `public-api`/`admin-api` (`docs/decisions.md:15`) | Code wins. Ingest goes on `public-api`, insights queries on `admin-api`. |

---

## 3. Backend API

Conventions for every new `admin-api` route, matching the existing code:

- `authenticate()` first (`packages/worker-kit/src/auth.ts:24`). Errors are JSON `{ error }` via `errorHandler` (`packages/worker-kit/src/hono.ts:11-19`).
- `panoId`/`tourId` path params are checked against `PANO_PATTERN` before any key builder runs, and a mismatch returns 400. Same approach as DELETE (`services/admin-api/src/index.ts:46-49`), because the key builders throw, which surfaces as a 500 (`packages/contracts/src/keys.ts:7-12`).
- **ETag semantics.** Body `etag` stays unquoted, the same as the existing PUT responses (`index.ts:40,79`, R2's `res.etag`). New GETs also set an HTTP `ETag: "<etag>"` header (quoted), and honour `If-None-Match` with 304 (R2 `get(key, { onlyIf: { etagDoesNotMatch } })`). PUT keeps accepting quoted or unquoted `If-Match`, since quotes are stripped (`conditional.ts:10`).
- Owner GETs send `Cache-Control: private, no-store`. Note that `putJson` stamps stored JSON `public, max-age=30` (`packages/worker-kit/src/r2-binding.ts:29`). That is harmless for private keys (not CDN-reachable) and fine for `pub/`/`slugs/`.
- Response zod schemas go in `@internal/contracts` (new `src/api.ts`) so `web-kit` can validate responses.

### 3.1 Owner read routes (BLOCKING, units A1–A2)

**Writes change so the lists work.** `putJson` (`r2-binding.ts:19-34`) gains an optional `customMetadata` argument. The config PUT writes `{ title }`. The tour PUT/POST writes `{ title, sceneCount, coverPanoId }` (the first scene). `publish.json` writes `{ slug, visibility }`. Summaries use `R2Object.uploaded` as `updatedAt`. Objects written before this change have no metadata, so the list falls back to one `getJson` for those (`r2-binding.ts:1-8`, which exists but nothing uses it yet).

#### `GET /api/admin/tours` (new)
- Auth: Bearer. Query: `?cursor=&limit=` (default 50, max 100).
- Implementation: `bucket.list({ prefix: 'tours/<owner>/', include: ['customMetadata'], cursor, limit })`, then group `tour.json` + `publish.json` by tourId.
- 200 `{ tours: TourSummary[], cursor: string | null }`
  `TourSummary = { tourId, title, sceneCount, coverPanoId: string|null, updatedAt: ISO, etag, publish: { slug, visibility: 'public'|'unlisted' } | null }`
- The client builds the cover thumbnail itself from `coverPanoId` plus the pano's manifest (see the pano summary). View counts are fetched per card from the existing public `GET /api/tours/:tourId/stats` (`services/public-api/src/index.ts:32-40`). That fan-out is public, so it needs no ownership check. Dashboard totals are summed client-side.

#### `GET /api/admin/panos` (extended, additive)
- 200 `{ panoIds: string[], panos: PanoSummary[], cursor: string | null }`. `panoIds` stays for compatibility (`index.ts:19-25`; the smoke test in `docs/deploy.md:447` uses it).
- Implementation: `listChildren` over `panos/<owner>/` (existing, `r2-binding.ts:36-45`). For each panoId in the page (concurrency 8): `list({ prefix: panoPrefix, include: ['customMetadata'] })` and `get(manifestKey)`.
- `PanoSummary = { panoId, title: string|null, hasConfig, hasOriginal, deleting: boolean /* tombstone */, tiling: 'ready'|'pending'|'failed'|'none', manifest: { version, format, tileSize } | null, updatedAt }`
  - `tiling`: **checked in this order** (review fix, 2026-09-26 — a same-etag race can otherwise show a pano that tiled successfully as `failed`, so `ready` is checked first, not last): (1) `ready` if the manifest exists (the `get(manifestKey)` above, unchanged) **and** the etag captured from its `version` field (match `/^t\d+-(.+)$/` and take the capture group, not the whole string) equals the pano's current original etag (the bare, native-binding etag of the `/original` entry the same prefix `list()` call already returned — no extra read). Comparing only the etag capture, not the full `t<TILER_OUTPUT_VERSION>-<etag>` string, matters because a `TILER_OUTPUT_VERSION` bump changes every *future* tile's version prefix without rewriting already-tiled manifests — a full-string compare would drop every existing pano to `pending` the moment the tiler version bumps, until each one happened to be re-tiled. (2) Else `failed` if a `tile-failed` marker exists **and** `marker.originalEtag === original.etag` — read straight from the marker's R2 `customMetadata` (`{ reason, originalEtag }`, unit B4), which is present in the *same* `list({ prefix: panoPrefix, include: ['customMetadata'] })` call above, since `panos/<owner>/<panoId>/tile-failed` falls under that same prefix — no extra list or GET either. A marker whose `originalEtag` doesn't match the current original is stale (a later upload superseded the failed one) and is ignored. (3) Else `pending` if there's an original — this is also what an old manifest for a *replaced* image falls into: its `version` no longer matches step (1)'s check, so it correctly reads `pending` (or `failed`, per step (2)), never a stale `ready`. (4) Else `none`. **Read cost, stated honestly:** no new round trip — a manifest GET per pano was already budgeted above for readiness, and the marker's `customMetadata` rides along on the existing per-pano prefix `list()` call; only the fields read from each response changed.
- Used by the editor's "Add pano → from library" picker and for thumbnails. The dashboard itself is tour-based.

#### `GET /api/admin/panos/:panoId` (new)
- 200 `{ config: SceneConfig, etag, status: Omit<PanoSummary,'panoId'|'title'> }`, plus the `ETag` header.
- 304 on a matching `If-None-Match`.
- **404 (design item 4):** `{ error: 'config not found', deleting: boolean, hasOriginal: boolean }`. The UI branches on the flags:
  - `deleting: true` (a tombstone from an interrupted delete, `services/admin-api/src/delete-pano.ts:23`; `docs/deploy.md:493-496`): show "Deleting…" and re-issue `DELETE` (idempotent, and it resumes). The dashboard does this once automatically and otherwise offers a "Finish deleting" action.
  - `hasOriginal && !deleting` (an uploaded original whose config was never written): show "Untitled pano", and "Set title" creates the config with `If-Match: *`.
  - Both false: the pano is gone. The editor shows a "Missing pano" scene with "Remove from tour", and publish refuses it (3.2).
- `?status=1` returns only `status` (cheap polling for the upload chip's failure detection).

#### `GET /api/admin/tours/:tourId` (new)
- 200 `{ tour: TourDoc, etag, publish: {slug, visibility, publishedAt} | null }`, plus the `ETag` header. 304 on `If-None-Match`. 404 `{ error: 'not found' }`.
- `?include=configs` adds `configs: Record<panoId, { config, etag } | { missing: true, deleting, hasOriginal }>`. The editor loads the tour and every scene config in one round trip (concurrency 8), and every per-document ETag it will later send as `If-Match` comes from that single load.

#### `DELETE /api/admin/tours/:tourId` (new; the dashboard delete needs it)
- Idempotent 204. Order: unpublish (3.2), delete `publish.json`, delete `tour.json`, then delete this tour's panos that no other tour of the same owner references.
- **Q5, decided:** deleting a tour deletes the panos that no other tour of the same owner references (not the draft's "keep everything" default). Reference check: list the caller's other tours (`tours/<owner>/*/tour.json`, excluding the one just deleted) and union their scene panoIds; any of this tour's panoIds not in that union get deleted via the existing per-pano delete path (tombstone → purge, `services/admin-api/src/delete-pano.ts`), the same as a manual pano delete from the library. A pano still referenced by another tour is left alone.
- This makes tour delete a list-then-fan-out rather than three fixed key deletes, so the dashboard treats it as an async operation (spinner/optimistic-remove), not instant.

#### Write-route guards changed alongside (unit A1)
- `PUT /api/admin/tours/:tourId`: **refuses to create.** A missing key returns 404 even with `If-Match: *`. Today `If-Match: *` maps to an unconditional put (`conditional.ts:10`, `r2-binding.ts:25-26`), so a caller can create `tours/<self>/<any id>/tour.json` with an id of their choosing. That's harmless today, but once `pub/tours/<tourId>.json` is owner-free (3.2), a chosen id equal to someone else's tourId would let the caller overwrite that tour's public copy. With this guard, tourIds only come from `POST` (`crypto.randomUUID()`, `index.ts:56`), the same invariant panoIds already have (`docs/decisions.md:30`). The test at `services/admin-api/src/routes.test.ts:298-314` keeps passing (it POSTs first).
- `PUT /api/admin/panos/:panoId/config`: returns **409 `{ error: 'pano is being deleted' }`** if the tombstone exists, so a save that races an interrupted delete can't resurrect a half-deleted pano. Creating a config with `If-Match: *` stays allowed (the existing tests at `routes.test.ts:76-87,197` depend on it). Publish does its own ownership proof (below), so a foreign panoId config gains nothing.

### 3.2 Share links: `pub/` and `slugs/` (unit B2)

**Storage keys (new builders in `packages/contracts/src/keys.ts`, all owner-free):**
- `pub/tours/<tourId>.json`: the public bundle
  ```ts
  PublishedTour = { v: 1, tourId, title, visibility: 'public'|'unlisted', slug, publishedAt,
    settings: TourSettings, startPanoId: string,
    scenes: Array<{ panoId, mapX?, mapY?, config: SceneConfig }> }
  ```
  It must never contain `sub` or an owner segment. A test asserts that the serialized bundle contains no `panos/` substring and no owner encoding.
- `slugs/<slug>.json`: either a live pointer `{ v: 1, kind: 'tour', tourId }`, or, for a slug a tour has moved away from, a time-limited alias `{ v: 1, kind: 'redirect', tourId, redirect: '<new-slug>', expiresAt: ISO }` (**Q6**, decided — see below).
- Private: `tours/<owner>/<tourId>/publish.json`: `{ slug, visibility, publishedAt }` (D6).

**Slug rules** (shared validator in contracts, also used by the share modal):
- Normalise the way the design specifies (design README:127): lowercase, `[^a-z0-9-]` → `-`. On top of that: collapse repeated `-`, trim leading/trailing `-`.
- Valid: `/^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/` (3–40 chars).
- Reserved: `api, app, admin, s, embed, new, edit, settings, login, logout, callback, auth, privacy, terms, help, docs, static, assets, tiles, pub, slugs, cdn, www, panote`. A redirect alias's `redirect` target is itself just another slug and passes the same validator.
- Default slug is `slugify(title)`. If that's taken, add `-2`…`-9`, then a random 6-char suffix. An empty or reserved result becomes `tour-<6 random>`.
- Alias lifetime: `SLUG_ALIAS_DAYS`, a new `admin-api` var, default 30, so it's configurable per env without a code change.

**Routes (admin-api, Bearer, all ownership-checked via `head(tourKey(sub, tourId))` → 404):**

| Method / path | Body | Result | Errors |
|---|---|---|---|
| `POST /api/admin/tours/:tourId/publish` | `{ visibility?, slug? }` | 200 `{ slug, visibility, url: '/s/<slug>', publishedAt }` | 404 tour, 409 `slug taken`, 422 `{ error, scenes: [{ panoId, reason: 'missing'|'deleting'|'not-owned'|'not-ready' }] }` |
| `PUT /api/admin/tours/:tourId/slug` | `{ slug }` | 200 `{ slug, oldSlugRedirectsUntil: ISO \| null }` | 400 invalid/reserved, 409 taken, 404 |
| `PATCH /api/admin/tours/:tourId/visibility` | `{ visibility }` | 200 `{ visibility }` | 404, 409 `not published` |
| `DELETE /api/admin/tours/:tourId/publish` | — | 204 (idempotent) | — |

Publish algorithm (idempotent, safe to retry):
1. Read the tour and every scene config under the caller's prefix. **Ownership proof per scene:** `head(originalKey(sub, panoId))` must exist and there must be no tombstone. A config PUT alone isn't proof, because foreign-panoId configs are allowed (`routes.test.ts:197`). The manifest must exist (`not-ready` otherwise). All failures are collected into the 422.
2. Slug claim: `put(slugs/<slug>.json, …, { onlyIf: { etagDoesNotMatch: '*' } })` (create-only, the same primitive as `POST` tours, `index.ts:62`). If that fails, read the slug: if it's a live pointer at this tourId, it's ours (idempotent). If it's a `redirect` record whose `redirect` target is this tour's current slug, that's also ours (a retried rename) and the claim step is skipped. Otherwise 409.
3. Write `pub/tours/<tourId>.json` (unconditional) and `publish.json`.
4. **On a slug change (Q6, decided — CHANGED from the draft's proposal):** the draft proposed releasing the old slug immediately. Instead, the old `slugs/<old>.json` is rewritten in place (not deleted) to a `redirect` record — `{ v: 1, kind: 'redirect', tourId, redirect: '<new-slug>', expiresAt: now + SLUG_ALIAS_DAYS }` — but only if it still points at this tourId (a live pointer, or a `redirect` this tour already owns; a rename chain is collapsed to point straight at the current slug rather than left as a multi-hop chain). The old slug keeps resolving, as a redirect, until it expires; it is not released early by a further rename.
5. **Alias expiry.** A new daily `admin-api` Cron Trigger lists `slugs/` with `include: ['customMetadata']` (the write in step 4 also stamps `customMetadata: { kind: 'redirect', expiresAt }` so the sweep is a list, not a get-per-key) and deletes every `redirect` record past `expiresAt`. After that the slug is released and free to be claimed by anyone, same as the draft's immediate-release behavior, just delayed by up to `SLUG_ALIAS_DAYS`.

Unpublish deletes the slug (only if it's a live pointer to this tour — a `redirect` alias left over from an earlier rename is not touched and still expires on its own schedule), `pub/tours/<tourId>.json` and `publish.json`, then does a best-effort CDN purge of those two URLs (3.5).

**When publish is called:** the editor calls `POST …/publish` after every successful Save (Save = PUT configs, then PUT tour, then publish). **Q3, decided:** a tour becomes live by link on its first Save with ≥1 ready pano — that Save's publish call is what makes it live, not the share modal being opened — with default visibility **Unlisted**.

**What the public viewer and the embed read:**
- `/s/:slug` and `/s/:slug/embed[?pano=<panoId>]` are page routes on the **website Worker**. `slugs/*.json` is plain JSON served straight from R2 via `cdn.panote.dev` — a direct fetch of that URL returns the JSON body with a 200 and cannot itself redirect — so resolving a `redirect` record into an actual HTTP redirect needs a decision about which layer does it.
  - **Decided (Q6):** the website Worker returns the HTTP redirect. It gains a small `main` script scoped to `/s/*` only (everything else keeps falling through to the static assets/SPA exactly as before, section 5) that reads `slugs/<slug>.json` via an R2 binding (not the public CDN fetch) ahead of the asset handler. A `redirect` record gets an HTTP **308** to `/s/<new-slug>` (or `/s/<new-slug>/embed`, preserving `?pano=`), uncached (`Cache-Control: no-store`), so curl, share-preview crawlers and any other system following the link see a real redirect status, not just client-side JS. A live pointer (or a miss) falls through to the asset handler, and the SPA does its normal client-side chain: fetch `${CDN}slugs/<slug>.json`, then `${CDN}pub/tours/<tourId>.json`, then `PanoViewer({ baseUrl: CDN+'tiles/' }).load(startPanoId)` (the manifest and tiles follow).
  - This pulls one small piece of the otherwise-optional **W3** ("website Worker script") forward into Wave 6, since D1's assets-only Worker with no `main` can't return a 308 on its own. The rest of W3 (404s for unmatched `/api/*`, OG tags) is unaffected and stays deferred/optional.
- A 404 at any step (slug not found, or a redirect whose target is itself missing) shows the "This tour isn't available" placeholder. That's also the embed placeholder the design asks for (design README:162).
- `?pano=` limits the embed to one scene with no nav links (design README:130).
- `visibility: 'unlisted'` adds `<meta name="robots" content="noindex">`. There is no discovery surface yet, so today that is the only difference between the two.
- Caching: `.json` isn't edge-cached on the CDN (`docs/deploy.md:612-615`), and `putJson` sets `max-age=30` (`r2-binding.ts:29`). An unpublish is therefore effective within about 30s with no purge needed. No cache rule gets added for `/pub/` or `/slugs/`. The website Worker's own 308s are uncached, so a redirect target can be corrected without waiting out an edge cache.

### 3.3 Insights: Workers Analytics Engine (unit B5)

**Binding.** `public-api`: `analytics_engine_datasets: [{ binding: 'EVENTS', dataset: 'panote_events_dev' }]` under `env.dev`, and `panote_events` under `env.production`. It has to be repeated per env (`docs/STANDARDS.md:100`), and `env.d.ts` regenerated (the CI drift check is in `.github/workflows/ci.yml`, job `generated-types`).

**Event schema (one data point per event):**

| Field | Value |
|---|---|
| `indexes[0]` | `tourId` (the sampling key, so per-tour queries stay accurate under sampling) |
| `blobs[0]` | event type: `view` \| `scene` \| `hotspot` \| `dwell` |
| `blobs[1]` | `panoId` or `''` |
| `blobs[2]` | `hotspotId` or `''` |
| `blobs[3]` | surface: `page` \| `embed` |
| `blobs[4]` | schema version `v1` |
| `doubles[0]` | dwell ms (`dwell` only; clamped to [0, 4h]), else 0 |

**Ingest (public-api, anonymous):**
- `POST /api/tours/:tourId/view`, body `{ panoId?, surface? }`. Increments the DO as today (`services/public-api/src/index.ts:15-17`) **and** writes a `view` point.
- `POST /api/tours/:tourId/events`, body `{ events: Array<{ type: 'scene'|'hotspot'|'dwell', panoId?, hotspotId?, ms?, surface? }> }`. Max 20 per request, 204. Sent with `navigator.sendBeacon`. `dwell` is the visible time per visit, sent on `visibilitychange`→hidden/`pagehide`.
- Validation: `tourId`/`panoId` must match `PANO_PATTERN`, `hotspotId` must be ≤64 chars `[A-Za-z0-9_-]`, else 400. **This also closes an existing gap:** `public-api` currently passes any string to `idFromName` (`services/public-api/src/index.ts:13`), so arbitrary ids create DOs. Existence isn't checked, because `public-api` has no R2 binding (`docs/deploy.md:196-197`). Rate limiting is a later hardening item.

**Query path (admin-api):** `GET /api/admin/tours/:tourId/insights?days=14` (1–30, default 14).
- Checks ownership (`head(tourKey)` → 404), then POSTs SQL to `https://api.cloudflare.com/client/v4/accounts/<CF_ACCOUNT_ID>/analytics_engine/sql` with secret `CF_ANALYTICS_TOKEN` (Account Analytics: Read). New `admin-api` var: `AE_DATASET`.
- `tourId` is interpolated only after the `PANO_PATTERN` check (no bind parameters are assumed).
- 4 queries run in parallel. Counts always use `SUM(_sample_interval)`.
  - daily: `SELECT toStartOfDay(timestamp) AS d, SUM(_sample_interval) AS n FROM <ds> WHERE index1='<id>' AND blob1='view' AND timestamp > NOW() - INTERVAL '14' DAY GROUP BY d`
  - avg dwell: `SUM(double1*_sample_interval)/SUM(_sample_interval)` over `blob1='dwell'`
  - by pano: `blob1='view'` grouped by `blob2`
  - top points: `blob1='hotspot'` grouped by `blob2, blob3`, `ORDER BY n DESC LIMIT 5`
- 200 `{ days, from, to, totalViews, avgDwellMs: number|null, daily: [{ date: 'YYYY-MM-DD', views }] /* zero-filled, UTC */, byPano: [{ panoId, views }], topHotspots: [{ panoId, hotspotId, opens }] }`. Titles are resolved client-side from the loaded configs.
- 502 `{ error: 'analytics unavailable' }` if the SQL API fails. The modal then shows "Insights unavailable". It never fabricates numbers (design README:145).

**Privacy.** Store no IP, no user agent, no country, no referrer, no client id or cookie, and never the Auth0 sub. The only identifiers are content ids. Likes still use `X-Client-Id` for dedupe in the DO (unchanged, `index.ts:24`), and that id never reaches AE. Retention is AE's own (about 3 months per Cloudflare docs; confirm at implementation). The privacy page copy states that visits are counted without personal data. The data is only what the design shows (design README:143).

**Totals.** "Total views" in the modal is the 14-day AE sum. Dashboard "total views" is the all-time DO sum. The labels need to say which is which.

### 3.4 Upload hardening and replace-image (unit B3)

`POST /api/upload-url` body becomes `{ contentType: 'image/jpeg'|'image/png'|'image/webp', size: number, panoId?: string }`.
- `size` must be ≤ 150 MiB (the same limit as `consumer.ts:39`). Anything else → 400.
- The presign signs `content-type` (and `content-length` if R2 honours it for presigned PUTs; this needs a spike). That fixes `SignedHeaders=host` (`docs/deploy.md:606-608`; `packages/worker-kit/src/r2-s3.ts:46-54`). `presignPut` gains `opts.headers`.
- `panoId` present (replace image, the camera icon in screens 04/10): requires `head(originalKey(sub, panoId))` to exist and no tombstone, else 404. It then re-presigns the same key, and the re-tile happens automatically (`docs/deploy.md:463-465`). The panoId-uniqueness invariant holds because only an existing server-issued original is accepted (`docs/decisions.md:30`). This needs the R2 binding added to `upload-api` for the HEAD, or an S3 `head()` (`r2-s3.ts:60-63`, already available; no new binding needed).
- The upload uses `XMLHttpRequest`, because `fetch` has no upload progress and the chip's determinate bar needs it (design README:97).
- Dev CORS: add `http://localhost:5173`/`5174` in a new `infra/r2/cors.dev.json` for `pano-content-dev` only. `infra/r2/cors.json` stays prod-safe.
- **Known limitations, accepted for Wave 6:**
  - The browser can't read the PUT's ETag client-side: `infra/r2/cors.json` exposes no headers on either rule (lines 4-8, 11-16), which is why readiness is polled from the manifest instead.
  - Each replace leaves the previous version's tiles in place under `tiles/<panoId>/`, since a new upload derives a new `version` (`services/tiler-consumer/src/container.ts:110`) rather than overwriting the old one. They're only reclaimed when the pano itself is deleted (`deletePano` sweeps the whole `tiles/<panoId>/` prefix, `services/admin-api/src/delete-pano.ts:26`). Old-version cleanup stays deferred (section 1).
  - The 900s presign expiry (`packages/worker-kit/src/r2-s3.ts:34`) leaves a TOCTOU window: a replace presign issued just before a delete can still PUT after the delete completes, recreating the original under the caller's own prefix. Owner-only impact; not fixed in Wave 6.
  - Content-length is signed only if the pending R2 spike (above) finds that R2 honours it on presigned PUTs; until then it stays unverified server-side.

### 3.5 Tiling failure, CDN purge, cache rule (units B4, B6, O1)

- **B4 (DLQ + failure marker).**
  - `tiler-consumer` also consumes `pano-uploads-dlq[-dev]`. A queue consumer Worker can consume several queues, branching on `batch.queue`.
  - For each dead-lettered key it writes `panos/<owner>/<panoId>/tile-failed` (`{ reason, at, originalEtag }`, also mirrored into R2 `customMetadata: { reason, originalEtag }` so A2's list endpoint reads both with no extra GET, review fix) and logs at error level.
  - It writes the same marker on the two permanent-ack paths that today are only logged (oversize `consumer.ts:51-56`; unprocessable key `consumer.ts:58-67`, when the key's owner and panoId segments are both charset-valid — a charset-invalid key gets no marker at all, logged and skipped instead, review fix). This needs an R2 binding on `tiler-consumer`. Before any write, the original is re-HEADed (must still exist, with a matching etag) and its manifest is checked for a same-etag race, so a delete or a concurrent success already in flight is never overwritten with a stale `failed` marker (review fix).
  - A successful manifest swap deletes the marker.
  - Alerting: a Cloudflare notification or observability alert on DLQ-consumer error logs. This is a manual dashboard step, documented in `deploy.md`.
- **B6 (purge on delete).**
  - After `deletePano` succeeds, and after unpublish, `admin-api` calls the zone purge API: purge by prefix `cdn.panote.dev/tiles/<panoId>/`, and by URL for `pub`/`slugs`. Purge by prefix is available on all plans. Free-plan rate limit: 5 req/min, bucket 25, 100 prefixes per request.
  - Best-effort: failures are logged and never fail the DELETE.
  - New secret `CF_PURGE_TOKEN` (Zone → Cache Purge), vars `CDN_ZONE_ID`, `CDN_HOST`.
  - This closes the "deleted tiles keep serving" limitation (`docs/deploy.md:601-605,498-503`).
- **O1 (tile 404 caching).** Add a Cache Rule on `cdn.panote.dev` for `/tiles/*` with status-code TTL 404 → no-store (or 10s). This fixes the 4h 404 caching (`docs/deploy.md:609-611`). `manifest.json` stays uncached at the edge (DYNAMIC), which is correct for readiness polling, so only the doc wording changes. The poller also uses `cache: 'no-store'`.

### 3.6 Schema extensions (unit B1, additive, optional fields, backwards compatible)

- `SceneConfigSchema` (`schema.ts:36-42`) + `north?: number` (radians offset) and `startView` → reuse `initialView` (already there, `schema.ts:40`).
- `HotspotSchema` (`schema.ts:14-30`) + `icon?: string` (Font Awesome name, `/^[a-z0-9-]{1,40}$/`), `size?: number` (0.5–3), `media?: { kind: 'image'|'video'|'youtube', url?: string (https only), id?: string }`. YouTube is rendered via `youtube-nocookie.com`.
- `TourDocSchema` (`schema.ts:54-58`) + `startPanoId?: string` (PANO_PATTERN) and `settings?: { controls: 'bottom'|'top', showMap: boolean, showCompass: boolean, autoRotate: boolean }`.
- Documented units: yaw/pitch in radians, bounded to [-π, π] and [-π/2, π/2]; fov in degrees within [15, 80] (the viewer defaults, `packages/viewer/src/PanoViewer.ts:57-58`).
- `i18n` is not included (**Q4**).
- Size caps: `hotspots.max(200)`, `scenes.max(100)`, `body.max(20_000)`. Nothing caps size today, and `pub` bundles multiply it.

---

## 4. Frontend

### 4.1 Workspace layout

```
apps/website   @app/website   Vite SPA, base '/'      → Worker panote-website[-dev], route panote.dev/*
apps/admin     @app/admin     Vite SPA, base '/app/'  → Worker panote-admin[-dev],   route panote.dev/app*
packages/ui        @internal/ui        React components, tokens.css (all tokens on :root, design README:201), fonts, icons
packages/web-kit   @internal/web-kit   config, auth, api client, tour adapter, beacon, upload+poll machine (no React)
```

- Both apps: `tsconfig` extends `@internal/typescript-config/react.json`, ESLint uses `@internal/eslint-config/react` (both exist: `packages/typescript-config/react.json`, `packages/eslint-config/src/react.ts`), and Vitest uses the `browser` variant with jsdom (`packages/vitest-config/src/browser.ts`).
- New catalog entries, exact-pinned (`pnpm-workspace.yaml` catalog, `catalogMode: strict`): `react`, `react-dom`, `@types/react`, `@types/react-dom`, `vite`, `@vitejs/plugin-react`, `react-router`, `@tanstack/react-query`, `@auth0/auth0-spa-js`, `jsdom`, `@testing-library/react`, `@fontsource/schibsted-grotesk`, `@fontsource/spline-sans-mono`, `@fortawesome/fontawesome-free`.
  - Fonts and icons are self-hosted: no third-party font/CDN requests from visitor pages, and a simpler CSP.
  - None of these should need `allowBuilds`; confirm on first install (`pnpm-workspace.yaml:109-112`).
- `apps/*` are already workspace members (`pnpm-workspace.yaml:2`).

`@internal/web-kit` modules:
- `config.ts` (reads `import.meta.env.VITE_*`, validated with zod at boot)
- `auth.ts`
- `api/admin.ts`, `api/public.ts`, `api/upload.ts` (typed, response-validated)
- `tour-adapter.ts` (`TourDoc` + configs → viewer `Tour` + `InfoHotspotData[]`)
- `beacon.ts`
- `upload-machine.ts`: pure phase computation, `upload → processing → ready | failed | timed-out`, driven by XHR progress events and an interval poller, **not rAF** (design README:103)
- `slug.ts` (re-exported from contracts)

### 4.2 Routing

- **website:** `/` landing (+ `?signin=1` opens the modal), `/s/:slug`, `/s/:slug/embed`, `/privacy`, `/terms`, `*` → 404.
- **admin:** `/app/` dashboard, `/app/callback` (Auth0 redirect target for both apps), `/app/new` upload overlay (over the dashboard), `/app/t/:tourId` editor (`?pano=<panoId>` selects a scene), `/app/t/:tourId/preview` owner viewer, plus modal sub-routes `/app/t/:tourId/share/:tab(link|privacy|embed)` and `/app/t/:tourId/insights`.
- Admin route guard: signed out → `/?signin=1&next=<path>`.

### 4.3 Screen → route → data → endpoint

| Screen PNG | Route | Data needed | Endpoint(s) |
|---|---|---|---|
| `01-landing.png` | website `/` | Showcase tour for the live hero pano + "See a live tour" | CDN `slugs/<VITE_SHOWCASE_SLUG>.json` → `pub/tours/…` → manifest/tiles. Static copy otherwise. The drop target starts the sign-in (C11) |
| (sign-in modal, design README:77-79) | website `/?signin=1` | Enabled connections (config) | Auth0 `/authorize` via SPA SDK → `/app/callback` |
| `02-dashboard.png` | admin `/app/` | Tours (title, cover, scene count, updated), visibility, totals, per-tour views | `GET /api/admin/tours`; covers: `GET /api/admin/panos` (manifest version) → CDN tile URL; views: `GET /api/tours/:id/stats` per card; chip: `PATCH …/visibility`; duplicate: `GET /api/admin/tours/:id` + `POST /api/admin/tours`; delete: `DELETE /api/admin/tours/:id` via confirm |
| `03-upload.png` | admin `/app/new` (or "Add pano" in the editor) | File validation (type, bytes, pixels) | `POST /api/admin/tours` (new tour), `POST /api/upload-url` |
| `10-chip-uploading.png` | overlay chip (any admin route) | XHR progress | presigned `PUT` to R2 |
| `11-chip-processing.png` | chip | readiness | fresh upload: poll CDN `tiles/<panoId>/manifest.json` (backoff 1s→5s, `no-store`) until it exists. Replace-image: capture `manifest.version` before requesting the presign, then poll the same manifest until `version` differs from the captured value — identical bytes re-tile to the same `version` (`services/tiler-consumer/src/container.ts:110`), so "manifest exists" alone would report ready with the old image. Both cases: every 15s `GET /api/admin/panos/:id?status=1` for `tiling:'failed'` (A2's etag-matched check, unit B4, review fix — not simply "newer than the upload"), which also catches a failed replace-image, since the marker's `originalEtag` matches the newly-presigned original rather than the prior, successfully-tiled one; 10 min → timed-out with Retry (re-poll) / Re-upload (replace-image presign) |
| `12-chip-ready.png` | chip | — | on ready: `PUT …/config` (`If-Match: *`, title from filename) then `PUT` tour with the scene appended (`If-Match: <etag>`) |
| `04-editor.png` | admin `/app/t/:tourId` | Tour + all scene configs + ETags; manifests | `GET /api/admin/tours/:id?include=configs`; Save: `PUT /api/admin/panos/:id/config` × dirty, `PUT /api/admin/tours/:id`, `POST …/publish`; states saving/saved/conflict(412) per document ("changed elsewhere — reload or overwrite"; overwrite = retry with the fresh ETag, never `*`) |
| `13-confirm-modal.png` | modal in admin | — | delete point/pano-from-tour are local edits (persisted on Save); delete tour → `DELETE /api/admin/tours/:id` |
| `05-viewer.png` | website `/s/:slug` (visitor), admin `/app/t/:id/preview` (owner) | pub bundle, stats, like | CDN `slugs/…`, `pub/tours/…`; `POST /api/tours/:id/view`, `/events`, `/like` (`X-Client-Id` from localStorage), `GET …/stats`. "Edit" shows only if the user is signed in and `GET /api/admin/tours/:id` returns 200 |
| `06-share-link.png` | admin `…/share/link` | slug, visibility | `POST …/publish` (if needed), `PUT …/slug` (Enter/blur commits, Esc cancels; 409 → inline "taken"). Visitors on `/s/:slug` get a Link-only share (socials + copy, no slug edit) |
| `07-share-privacy.png` | admin `…/share/privacy` | visibility | `PATCH …/visibility` (exactly two options) |
| `08-share-embed.png` | admin `…/share/embed` | slug, current pano | none (the snippet is built client-side from `VITE_SITE_ORIGIN`) |
| `09-insights.png` | admin `…/insights` | 14-day series, avg time, by-pano, top points | `GET /api/admin/tours/:id/insights?days=14` |

The viewer chrome (controls pill, floor chevrons, mini-map, compass, hotspot panels, mobile bottom sheets) is React in `@internal/ui`, positioned via `viewer.project()`/`onRender()` (`packages/viewer/src/PanoViewer.ts:122,338`). The vanilla `ui/*` mounts (`packages/viewer/src/ui/index.ts`) are only reused where they already match the design. The viewer needs these additions (unit V1): auto-rotate, compass heading/north offset, hotspot-open and scene-change events for analytics, and optional mini-map positioning helpers. `grep` for `autoRotate|compass|minimap|north` in `packages/viewer/src` finds nothing today.

---

## 5. Deployment

**Hosting.** Two new Workers with `assets`. Admin needs no `main` at all. The website Worker also gets a small `main` script scoped to `/s/*` for the slug-redirect check (section 3.2, Q6, decided) — everything else still falls through to its static assets:
```jsonc
// apps/admin/wrangler.jsonc (sketch)
{ "name": "panote-admin", "compatibility_date": "2026-01-01",
  "assets": { "directory": "./dist", "not_found_handling": "single-page-application" },
  "env": {
    "dev":        { "name": "panote-admin-dev", "workers_dev": true,
                    "routes": [{ "pattern": "panote.dev/app*", "zone_name": "panote.dev" }],
                    "observability": { "enabled": true } },
    "production": { "name": "panote-admin", "workers_dev": false,
                    "routes": [{ "pattern": "panote.io/app*", "zone_name": "panote.io" }],
                    "observability": { "enabled": true } } } }
```
The website is the same with `panote.dev/*` / `panote.io/*`.
- Admin assets live under `dist/app/` so paths line up with the `/app/` base.
- A `_headers` file sets the CSP and framing: `frame-ancestors 'none'` everywhere except `/s/*/embed` (which gets `frame-ancestors *`).
- Unmatched `/api/*` paths now reach the website Worker and would get the SPA's `index.html` with a 200. That's acceptable for v1, and W3 adds the rest of the Worker script (404s for those, plus OG tags) — a separate concern from the `/s/*` redirect script above, which already ships in Wave 6.

**Hostnames.**

| | dev | production |
|---|---|---|
| website | `panote.dev/*` | `panote.io/*` (+ `www` → apex Redirect Rule) |
| admin | `panote.dev/app*` | `panote.io/app*` |
| APIs (unchanged) | `panote.dev/api/{admin/*,tours/*,upload-url}` | same on `panote.io` |
| CDN (unchanged) | `cdn.panote.dev` | `cdn.panote.io` (unprovisioned, `docs/deploy.md:544-546`) |

DNS: dev already has the proxied `AAAA @ 100::` (`docs/deploy.md:207-209`). Production needs the same record, which is part of the existing production provisioning list (`docs/deploy.md:553-555`).

**CSP (website and admin):**
- `default-src 'self'`
- `connect-src 'self' https://cdn.panote.dev https://<acct>.r2.cloudflarestorage.com https://panote-dev.au.auth0.com`
- `img-src 'self' https://cdn.panote.dev data: blob:`
- `frame-src https://www.youtube-nocookie.com`
- `script-src 'self'`

**Env/config (`apps/*/.env.dev`, `.env.production`, committed):** `VITE_SITE_ORIGIN`, `VITE_CDN_BASE`, `VITE_AUTH0_DOMAIN`, `VITE_AUTH0_CLIENT_ID`, `VITE_AUTH0_AUDIENCE`, `VITE_AUTH0_CONNECTIONS`, `VITE_SHOWCASE_SLUG`. Production values are `YOUR_…` placeholders until the prod tenant exists.

**Local dev:**
- `vite dev` proxies `/api` → `https://panote.dev`, so the APIs stay same-origin.
- The CDN is fetched directly, which needs the localhost dev CORS rule (3.4).
- The Auth0 dev SPA app allows `http://localhost:5173/app/callback`.

**Backend config additions:**
- `public-api`: `analytics_engine_datasets`.
- `admin-api`: vars `CF_ACCOUNT_ID`, `AE_DATASET`, `CDN_ZONE_ID`, `CDN_HOST`, `SLUG_ALIAS_DAYS`; secrets `CF_ANALYTICS_TOKEN`, `CF_PURGE_TOKEN` (add to `services/admin-api/src/env.d.ts`-style declaration, like `services/upload-api/src/env.d.ts:6-16`); a daily Cron Trigger for the slug-alias expiry sweep (3.2, Q6).
- `tiler-consumer`: R2 binding + DLQ consumer.
- `website`: R2 binding, read-only against the `slugs/` prefix, for the `/s/*` redirect script (3.2, Q6).
- Each change is repeated per env block (`docs/STANDARDS.md:100`).

**CI/CD changes:**
- `ci.yml`: `gate` already builds, typechecks, lints and tests everything via turbo, so the apps join automatically. Add `wrangler deploy --dry-run --env dev` for both apps to `deploy-dry-run` (the pattern at `ci.yml` "Dry-run deploy …" steps). The app `build` script defaults to `vite build --mode dev`.
- `deploy.yml`: add a `deploy-apps` job (matrix `website`, `admin`) that `needs: resolve-environment`. It runs `pnpm exec turbo run build --filter="@app/<app>..."` with `APP_MODE=<env>`, then `pnpm --filter @app/<app> exec wrangler deploy --env <env>`.
- Extend the placeholder guard's service list (`deploy.yml:148`) to scan `apps/*/wrangler.jsonc` and `apps/*/.env.production`.
- The existing `CLOUDFLARE_API_TOKEN` scopes cover this (Workers Scripts + Routes, `docs/deploy.md:292-295`). Deploying Workers with assets needs no extra permission (confirm on first deploy).

**One-time provisioning (dev now, production later, recorded in `docs/deploy.md`):**
- Auth0 dev: create a *Single Page Application* (`docs/deploy.md:444-445` records only an M2M test client). Callback URLs `https://panote.dev/app/callback`, `http://localhost:5173/app/callback`; logout/web origins accordingly; refresh token rotation on. Grant access to API `https://api.panote.dev`. Enable the connections chosen in Q2.
- AE dataset: created on first write.
- API tokens: Account Analytics Read, and Zone Cache Purge on `panote.dev`.
- Cache Rule for tile 404s (O1).
- Dev CORS file for `pano-content-dev`.

---

## 6. Work breakdown (PR-sized, dependency order)

Legend: **∥** = can run in parallel with other units in the same row group once its listed deps are merged.

**Phase 0: hygiene**
- **U0** `test(tiler): deflake build version test`. ∥, no deps. Fix `packages/tiler/src/build.test.ts:256` ("writes version and tilerVersion…", 5s default timeout): give the describe block a per-test `timeout` (or use a smaller `maxSize` fixture), after checking with `vitest --reporter verbose` whether the time goes into the first sharp mock or FS setup.
  *AC:* 20 consecutive `pnpm --filter @internal/tiler test` runs pass on CI.

**Phase A: owner reads (blocking; first)**
- **A1** `feat(admin-api): owner GET routes and write guards`.
  - `GET /api/admin/panos/:panoId`, `GET /api/admin/tours/:tourId` (`?include=configs`), `ETag`/`If-None-Match`/304, tombstone-aware 404 bodies.
  - `PUT tour` refuses to create (404). `PUT config` returns 409 while a tombstone exists.
  - Response schemas in `@internal/contracts/src/api.ts`.
  - *AC:* workerd tests in `services/admin-api/src/routes.test.ts` cover: 200 + ETag round-trip into a following `PUT` (200), a stale ETag giving 412, 304, cross-owner 404, tombstone 404 `{deleting:true}`, original-only 404 `{hasOriginal:true}`, a PUT to a never-POSTed tourId giving 404, config PUT under tombstone giving 409. Existing tests stay green. Deployed to dev, a `curl` with an M2M token returns a config.
- **A2** `feat(admin-api): list endpoints with summaries, delete tour`. Deps: A1.
  - `putJson` customMetadata; `GET /api/admin/tours`; extended `GET /api/admin/panos`; `DELETE /api/admin/tours/:tourId`.
  - *AC:* list returns titles/sceneCount/cover/updatedAt without per-item GETs when metadata is present (a test spies on `bucket.get`); pagination cursor works; legacy objects without metadata still list; `panoIds` unchanged; `tiling` state is correct for ready/pending/none; delete tour is idempotent; deleting a tour also deletes panos no other tour of the owner references, and leaves a pano shared with another tour untouched (tested with a two-tour fixture, Q5).

**Phase B: backend features** (after A1 unless noted)
- **B1** `feat(contracts): schema extensions and units`. ∥ with A2. Additive fields and caps (3.6).
  *AC:* old documents still parse; new fields round-trip through `PUT`/`GET`; bounds are rejected with 400.
- **B2** `feat(admin-api,contracts): publish, slugs, visibility`. Deps: A1, A2, B1.
  *AC:* create-only slug claim with a concurrency test (two tours, one slug → one 409); idempotent re-publish; 422 lists missing/deleting/not-owned/not-ready scenes; a foreign-panoId config can't be published; the pub bundle contains no owner data (asserted); unpublish removes the live pointer plus `pub`/`publish.json`; a slug change leaves the old slug as a `redirect` alias with `expiresAt` = now + `SLUG_ALIAS_DAYS` (default 30) rather than releasing it (Q6); a Cron Trigger sweep test frees an expired alias and leaves a live pointer and a not-yet-expired alias alone; dev `curl https://cdn.panote.dev/slugs/<slug>.json` → 200 and `/panos/…` still 403.
- **B3** `feat(upload-api): typed presign, size limit, replace image`. ∥ (no deps).
  *AC:* a presigned URL rejects a PUT with a different content-type (dev E2E); 400 over 150 MiB or a non-image type; the replace path 404s for a panoId without an original under the caller's prefix; dev CORS file added and applied.
- **B4** `feat(tiler-consumer): DLQ consumer, failure marker, alert`. ∥.
  *AC:* unit tests for marker writes on DLQ, oversize and unprocessable-key paths; the marker is cleared on success; `admin-api` reports `tiling:'failed'` (small follow-on in admin-api, or folded into A2 if B4 lands first); the alert is documented.
- **B5** `feat(public-api,admin-api): analytics ingest and insights`. ∥ after A1.
  *AC:* ingest validates ids and caps the batch; `writeDataPoint` is called with the documented schema (mocked binding); insights 404s for a non-owner; the query builder is snapshot-tested; zero-filled 14-day series; in dev, events appear in the SQL API within minutes; `env.d.ts` regenerated.
- **B6** `feat(admin-api): best-effort CDN purge on delete/unpublish`. Deps: A2 (delete tour), B2 (unpublish).
  *AC:* the purge call is mocked in tests; a purge failure still returns 204; in dev, an edge-HIT tile returns a miss/404 after delete.
- **B7** (optional) `feat(tiler): equirect preview image`. ∥. Writes `preview.webp` (1024×512) into the version dir, and adds optional `preview?: true` to core `Manifest` + `ManifestSchema` (both directions, `packages/contracts/src/manifest.ts:86-88`). Cards fall back to the level-0 `pz` face tile otherwise.
  *AC:* key-contract test updated; old manifests still parse.

**Phase V: viewer** (∥ with A/B)
- **V1** `feat(viewer): auto-rotate, north/compass hooks, interaction events`.
  *AC:* unit tests for auto-rotate idle resume and heading math; events `hotspot-open`/`scene-change` emitted; no new runtime deps (`packages/viewer/package.json:31-33`).

**Phase C: frontend foundation** (∥ with B)
- **C1** `feat(ui,web-kit): shared frontend packages`. Tokens, fonts, primitives (Modal, ConfirmModal, Segmented, Chip, Button), Logo, `PanoStage`; web-kit config/auth/api client/adapter/upload machine.
  *AC:* upload-machine and tour-adapter unit tests (including background-tab safety: phases advance from interval/XHR events with rAF mocked off); catalog entries pinned; `pnpm install --frozen-lockfile` clean.
- **C2** `feat(website,admin): scaffold apps and deploy pipeline`. Deps: C1.
  - Two Vite apps with routing shells, `wrangler.jsonc`, `_headers`, env files; the `ci.yml` dry-run and `deploy.yml` `deploy-apps` job + placeholder guard extension.
  - Rewrite docs: `docs/decisions.md:9,12,14,17,24`, `README.md:8,15-17`, `docs/STANDARDS.md:89`, `packages/typescript-config/react.json:3`; a new "Frontends" section in `docs/deploy.md`.
  - *AC:* after merge the dev auto-deploy serves `https://panote.dev/` and `https://panote.dev/app/` (deep links hard-refresh to 200); `https://panote.dev/api/admin/panos` still 401s without a token (route precedence verified); the production guard fails on `YOUR_` in the app env files.
- **C3** `feat(website,admin): Auth0 sign-in`. Deps: C2 + Auth0 SPA app provisioned. Sign-in modal, callback, guard, account menu, sign-out.
  *AC:* the dev login round trip with Google issues a JWT access token that `GET /api/admin/tours` accepts (200).

**Phase D: screens** (each ∥ with the others once its deps are in)
- **D1** website landing (01) + legal pages. Deps: C3. *AC:* copy passes the copy rule (a grep test for `open source|MIT|GitHub|export|download` in `apps/website/src`); ≤600px layout; the drop target resumes the upload after sign-in (Q1).
- **D2** dashboard (02, 13). Deps: A2, C3 (B2 for the visibility chip). *AC:* empty state; tombstoned pano auto-resumes DELETE; missing covers fall back gracefully; duplicate and delete work in dev.
- **D3** upload overlay + chip (03, 10–12). Deps: A1, B3, C3 (B4 for the failed state). *AC:* the real presign → PUT → manifest flow in dev for a fresh upload (manifest-exists); for replace-image, the chip captures `manifest.version` before the presign and only reports ready once a re-polled `manifest.version` differs from it, and re-uploading identical bytes (same `version`) does not falsely report ready and instead reaches the timed-out state; failed and timed-out states with retry; the chip survives a backgrounded tab.
- **D4** editor (04, 13). Deps: A1, B1, C3. *AC:* point add/edit/size/icon/media, connections aim/nudge/remove, start view/north, tour settings; Save sends one PUT per dirty doc with `If-Match`; a 412 shows the conflict UI (tested by editing in two tabs); a missing-config scene shows "Missing pano".
- **D5** public viewer + embed (05), plus the website Worker's `/s/*` redirect script (3.2, Q6). Deps: B2, V1, C2. *AC:* `/s/<slug>` and `/embed?pano=` load from the CDN only (plus stats/view/like); a slug that's a `redirect` alias returns an HTTP 308 to the new slug (checked with `curl -I`) before the SPA loads; the unavailable placeholder shows on 404; `noindex` for unlisted; embed framable, other pages not; like dedupe via `X-Client-Id`.
- **D6** share modal (06–08). Deps: B2, D4 or D5. *AC:* slug normalise/commit/cancel; 409 inline; exactly two privacy options; embed snippet matches the design's format with the env host.
- **D7** insights modal (09). Deps: B5, D4. *AC:* renders the real series; "unavailable" on 502; no client-side fabrication.

**Phase O: ops/docs** (runs alongside the unit that needs it)
- **O1** Cache Rule for tile 404, dev CORS, Auth0 SPA app, API tokens, AE dataset. Each step is added to `docs/deploy.md` with a status line (the same style as `docs/deploy.md:135-136`).
- **W3** (optional, later) website Worker script: 404 for `/api/*` misses, OG tags on `/s/:slug` via HTMLRewriter from the pub bundle.

Critical path: **A1 → A2 → B2 → D5/D6**, and **C1 → C2 → C3 → D2/D4**. U0, B3, B4, B5, B7, V1 and C1 can all start immediately.

Follow-up triage (the six listed items):

| Item | Wave 6? | Where |
|---|---|---|
| CDN purge on delete | Yes | B6 |
| Presign pins only `host`; no size limit | Yes (the upload UI ships) | B3 |
| Tile 404 cached 4h / manifest not edge-cached | 404 rule yes (O1). Manifest: no change, documented as intended | O1 |
| `upload-api` lacks an observability block | **Already done**: `services/upload-api/wrangler.jsonc:17,31` both have `"observability": { "enabled": true }`, and `docs/deploy.md:28` says all four have it | none |
| No DLQ / tile-failure alerting | Yes (the chip's failed state depends on it) | B4 |
| Flaky tiler test | Yes, first | U0 |

---

## 7. Decisions (user, 2026-09-26)

The draft's six open questions are resolved as follows. Section references point at where the plan text was updated accordingly.

- **Q1. Anonymous upload vs "no sign-up" copy.** Landing copy changes to "free — sign in with Google, live in seconds"; uploads stay authenticated. No anonymous uploads. (C11, section 2.)
- **Q2. Sign-in providers.** Google-only sign-in in Wave 6; Apple and Facebook buttons are hidden. (C12, section 2.)
- **Q3. Is every tour live by link, and what's the default visibility?** A tour becomes live by link on its first Save with ≥1 ready pano; default visibility is **Unlisted**. (Section 3.2, "When publish is called".)
- **Q4. Multi-language (`i18n`) in Wave 6?** Deferred to Wave 7; the language switcher is hidden. (Section 1 scope boundary; section 3.6.)
- **Q5. Deleting a tour: delete its panos too?** Deleting a tour deletes the panos that no other tour of the same owner references. (Section 3.1, `DELETE /api/admin/tours/:tourId`.)
- **Q6. Slug changes: should old links keep working? — CHANGED from the draft's proposal.** The draft proposed releasing the old slug immediately. Decided instead: when a slug changes, the old slug stays as an alias for a limited period (default 30 days, configurable via a new `SLUG_ALIAS_DAYS` var) and resolves with a clear redirect status, so other systems can adjust rather than hitting a dead link right away. Concretely: `slugs/<old>.json` becomes an explicit record, `{ "kind": "redirect", "redirect": "<new-slug>", "expiresAt": … }`, and — because that file is served straight from R2 via `cdn.panote.dev` with no server logic of its own — the **website Worker** is the component that turns it into an HTTP redirect: a small `main` script scoped to `/s/*` reads the slug via an R2 binding and returns a real HTTP **308** to `/s/<new-slug>` ahead of the SPA, which is a piece of the previously-optional "W3" website Worker script pulled forward into Wave 6 for this reason. After `expiresAt`, a new daily Cron Trigger on `admin-api` releases the old slug. (Section 3.2, "Share links"; the updated `B2` and `D5` acceptance criteria in section 6; the `Hosting` and `Backend config additions` notes in section 5.)
