# Deploy

How panote's four Workers get provisioned and deployed, and what state that provisioning is
actually in today. One Cloudflare account (`12e2809e05de8a2bf20b815fd394ec9a`), two Wrangler
named environments (`dev` → `panote.dev`, `production` → `panote.io`) per Worker's
`wrangler.jsonc`. See `docs/decisions.md` for why things are shaped this way; this doc is the
"how to actually run it" companion.

Resource names (R2 bucket, queues) deliberately keep the `pano-*` prefix inherited from
pano-viewer — the dev bucket and queues are the *same* Cloudflare resources pano-viewer's
Workers already use, cut over rather than recreated. Worker script names are `panote-*`.

---

## What deploys where

| Service | Script (dev / production) | Route (dev / production) | Bindings | Secrets |
|---|---|---|---|---|
| `services/public-api` | `panote-public-api-dev` / `panote-public-api` | `panote.dev/api/tours/*` / `panote.io/api/tours/*` | `STATS` — Durable Object, class `TourStats` | none |
| `services/admin-api` | `panote-admin-api-dev` / `panote-admin-api` | `panote.dev/api/admin/*` / `panote.io/api/admin/*` | `BUCKET` — R2, bucket `pano-content-dev` / `pano-content` | none (native R2 binding, not the S3 API) |
| `services/upload-api` | `panote-upload-api-dev` / `panote-upload-api` | `panote.dev/api/upload-url` / `panote.io/api/upload-url` | none (S3 API via `R2_ACCOUNT_ID`/`R2_BUCKET` vars) | `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` |
| `services/tiler-consumer` | `panote-tiler-consumer-dev` / `panote-tiler-consumer` | none — queue consumer, no `fetch` handler | `TILER` — container Durable Object, class `Tiler`; queue consumer on `pano-uploads-dev` / `pano-uploads` (`max_batch_size: 1`, `max_retries: 3`, dlq `pano-uploads-dlq-dev` / `pano-uploads-dlq`, `max_concurrency: 5`) | `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` (forwarded into the container's `process.env` via `Container.envVars` — see `services/tiler-consumer/src/container-env.ts`) |

All four: `observability.enabled: true` in both env blocks. `workers_dev` is `true` in `dev`
(the `*.workers.dev` URL stays reachable for smoke tests even once routes are live — see the
DNS section) and `false` in `production`. Every `OAUTH_ISSUER` var ships as a literal
placeholder (`https://YOUR_DEV_TENANT.auth0.com/` / `https://YOUR_PROD_TENANT.auth0.com/`)
until an Auth0 tenant exists — `isIssuerConfigured` in `packages/worker-kit/src/auth.ts` rejects
it before any network call, logging one `console.error` and returning 401. That guard runs
inside `authenticate()` on every request, but only *after* the bearer-token check: a request with
no `Authorization` header at all 401s first, before `isIssuerConfigured` ever runs, so it produces
no log line. Only a request that supplies some bearer token — even a bogus one — reaches the
issuer guard and produces the `console.error`. Nothing checks it once at startup. See the smoke
test step below for how to actually see that log line, and `docs/decisions.md` for why the
placeholder must only ever be replaced by a real tenant URL, never renamed to another fake one.

`admin-api` and `upload-api` require a bearer token on every route (`authenticate`);
`public-api` verifies it when present but never requires it (`authenticateOptional`) — its only
bimodal route is `POST /api/tours/:tourId/like` (falls back to an `X-Client-Id` header when
anonymous).

---

## One-time provisioning

Account-level commands (bucket, queues, notification, CORS) work from any Worker package —
`wrangler` is a devDependency of each `services/*` workspace, not a global install. Commands
below run through `@service/admin-api`; any of the four would do. All commands below assume
you're running them from the repo root — `pnpm --filter <pkg> exec <cmd>` runs `<cmd>` with the
matched package's directory as its cwd (not the repo root), which is why a relative
`--file` path below is `../../infra/r2/cors.json` rather than `infra/r2/cors.json`.

**Status today: dev is provisioned, production is not.** `pano-content-dev`,
`pano-uploads-dev`, and `pano-uploads-dlq-dev` already exist (inherited from pano-viewer's
provisioning). `pano-content`, `pano-uploads`, and `pano-uploads-dlq` do not — `panote.io` is
still on Route 53, not Cloudflare, so production provisioning can't start yet (see DNS section).

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

**Status: outstanding in both environments** — `pano-content-dev` currently has no CORS
configuration set.

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
global network before it hits cache." The Free plan allows 5 custom rules; this uses 1. Before
relying on `starts_with` for this, verify that URL normalization is enabled (Rules → Settings) so
a path trick like `/tiles/../panos/` can't slip past the check — **UNVERIFIED**, confirm this on
the zone. Mirror the same rule for `cdn.panote.io` on the `panote.io` zone in production, host
`cdn.panote.io`, before attaching that domain.

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
URL. **Status: outstanding in both environments** — `pano-content-dev` currently has no custom
domain (`r2.dev` is disabled on it too, so it isn't reachable any way today), and the WAF rule
above does not exist yet either.

### Secrets

`upload-api` and `tiler-consumer` each need an R2 API token scoped to the bucket with Object
Read & Write permission, split into two secrets:

```bash
pnpm --filter @service/upload-api exec wrangler secret put R2_ACCESS_KEY_ID --env dev
pnpm --filter @service/upload-api exec wrangler secret put R2_SECRET_ACCESS_KEY --env dev
pnpm --filter @service/tiler-consumer exec wrangler secret put R2_ACCESS_KEY_ID --env dev
pnpm --filter @service/tiler-consumer exec wrangler secret put R2_SECRET_ACCESS_KEY --env dev
```

Repeat with `--env production` once production is provisioned. `admin-api` and `public-api`
need no secrets — `admin-api` reads R2 through the native binding, not the S3 API; `public-api`
never touches R2 at all. `wrangler deploy --env <env> --secrets-file <file>` is the alternative
to interactive `secret put` if scripting this. **Status: outstanding** — no secrets are set in
either environment yet, so `upload-api` and `tiler-consumer` cannot presign or write to R2 in
either env today.

---

## DNS / zone setup

- **`panote.dev`** — being moved to Cloudflare now (not this doc's job to execute, tracked
  separately): add it as a site in the Cloudflare dashboard, copy the two assigned nameservers
  into Namecheap → Domain → Nameservers → Custom DNS (the domain stays registered at Namecheap),
  check imported records (MX etc.) before switching, then wait for the zone to go Active.
  `admin-api`, `public-api`, and `upload-api`'s dev `routes` blocks all target `panote.dev`, and
  `wrangler deploy` attaches a declared route as part of the deploy itself — it fails outright if
  the route's zone isn't on the account. **This makes the zone being Active a prerequisite for
  the first dev deploy, not something `workers_dev: true` lets you work around**: whether a zone
  that's merely Pending (added but not yet Active) is enough for the route attach to succeed is
  unverified, so the instruction is to wait for Active before deploying at all. A routes-only
  hostname additionally needs a proxied DNS record to exist (a placeholder proxied `AAAA @ 100::`
  until the Wave 6 Pages site is real) — create that before the first deploy too. Once deployed,
  `workers_dev: true` does still give a second, always-reachable `*.workers.dev` URL for smoke
  tests, independent of the route.
- **`panote.io`** — currently on AWS Route 53, not Cloudflare. Production is blocked on this
  move happening (same steps as above) before *any* production provisioning — bucket, queues,
  routes, custom domain — can proceed.

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
(`github.event.workflow_run.head_sha`), not whatever `main` has moved to since. Until
`DEV_AUTO_DEPLOY` is set to `true`, every deploy, dev included, stays a deliberate manual
action — `dev`'s `tiler-consumer` can't attach to `pano-uploads-dev` until the old pano-viewer
`pano-tiler-dev` Worker is detached (a queue allows exactly one consumer), so an automatic dev
deploy would fail on every trigger until the queue cut-over below has happened (see the
`deploy-tiler-consumer` job comment). `production` is additionally
hard-guarded to `main` — the `resolve-environment` job's "Guard production to main" step fails
the run with an `::error::` annotation if `github.ref` isn't `refs/heads/main` — hard-stops
unless the repo variable `PRODUCTION_PROVISIONED` is the literal string `true` (the
`resolve-environment` job's "Fail unless production is provisioned" step) — and fails closed if
any of the four services' `wrangler.jsonc` `env.production` block still contains a `YOUR_`
placeholder anywhere (the `resolve-environment` job's "Fail if any production config still has a
YOUR_ placeholder" step). That's a single case-insensitive check, run once for all four services'
configs rather than duplicated per deploy job: both `deploy-workers` and `deploy-tiler-consumer`
`need: resolve-environment`, so this one check failing blocks every deploy job, including
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
- `DEV_AUTO_DEPLOY` as a repository variable, set to the literal string `true` **only** after
  both the first dev deploy checklist below and its queue cut-over step have already succeeded
  by hand. Until the cut-over, `tiler-consumer` can't attach to `pano-uploads-dev` (the old
  pano-viewer `pano-tiler-dev` Worker still holds the slot), so an auto-deploy triggered before
  then would fail on every `CI` success on `main`. Leave it unset or anything other than `true`
  until both have happened.

---

## First dev deploy checklist

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
     `POST /api/upload-url`) → `401` either way, but the log line differs by request: a plain
     `curl` with no `Authorization` header at all 401s on the bearer-token check, before the
     issuer guard ever runs, so it logs nothing. Send a dummy bearer instead —
     `curl -H 'Authorization: Bearer x' ...` — to reach the issuer guard and see the
     `OAUTH_ISSUER is unconfigured or a placeholder - all authenticated requests are rejected`
     line in `wrangler tail --env dev` for that service. This is expected until an
     Auth0 tenant exists — it confirms the guard is rejecting loudly rather than silently
     falling through. A path neither service declares → `404` (Hono's default for `admin-api`;
     `upload-api`'s handler checks method + pathname itself and returns 404 explicitly) — don't
     expect `401` from an unmatched path, only from a real route with no/invalid token.
5. **Queue cut-over**, only after steps 3-4 pass.

   **Pre-cut-over check, first:** confirm `pano-content-dev` still has 0 objects —
   ```bash
   pnpm --filter @service/admin-api exec wrangler r2 bucket info pano-content-dev
   ```
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
6. **End-to-end test** — only meaningful once an Auth0 dev tenant exists (a Wave 5
   prerequisite; `OAUTH_ISSUER` is still a placeholder as of this writing, so every authenticated
   route 401s and this step cannot run yet):
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
or URL is the only way to revoke access sooner; automated purge on delete is deferred.

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
deleted again.

---

## Production status

**Unprovisioned.** None of the following exist yet: `pano-content`, `pano-uploads`,
`pano-uploads-dlq`, the R2→queue notification, bucket CORS, the `cdn.panote.io` custom domain,
`R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY` secrets, or a production Auth0 tenant. `panote.io` is
not a Cloudflare zone, so the `routes` blocks each Worker's `wrangler.jsonc` already declares
for `production` cannot take effect regardless. Every `production` env block in every
`wrangler.jsonc` is deliberately declared-but-unprovisioned — the config exists so Wave 5
doesn't have to reverse-engineer it, but none of it is live. Before a production deploy can
succeed: move `panote.io` to Cloudflare (DNS section above), run every "outstanding" step in
One-time provisioning above with `production` in place of `dev`, provision the production Auth0
tenant, get the `production` GitHub Environment's reviewer approval configured, and — only once
all of that is actually done — set the repository variable `PRODUCTION_PROVISIONED` to the
literal string `true`. `deploy.yml`'s `resolve-environment` job hard-stops any production deploy
until that variable is `true` (see GitHub setup above); it exists because nothing downstream can
otherwise tell "provisioned" from "not provisioned" on its own — `wrangler deploy` would just
fail mid-matrix against whichever resource happens to be missing for whichever service deploys
first.

---

## Known unverified areas

- **The container on real Cloudflare.** `services/tiler-consumer/Dockerfile`'s STATUS note
  (2026-08-12): the image builds and runs correctly under Docker 29.4.0 on an x86_64 host — a
  real `sharp` decode/resize/encode round trip against an S3-compatible endpoint produced
  correct tiles and manifests at multiple zoom levels. The Queue-consumer-to-container
  `@cloudflare/containers` Durable Object lifecycle has never run against a real Cloudflare
  account.
- **arm64-host builds.** The Dockerfile pins `--platform=linux/amd64` on both stages because the
  only host it's been built on is x86_64; an arm64 host (e.g. Apple Silicon) build path is
  untested.
- **The real R2 S3 path.** `packages/worker-kit/src/r2-s3.ts`'s tests (`r2-s3.test.ts`) check
  URL shape and signature presence only — no test signs a request against, or reads/writes,
  real R2. `upload-api`'s presigned PUT and the tiler container's S3 writes are unverified
  end-to-end.
- **Queue / Durable Object lifecycle** generally — the dev queue and DO namespaces have never
  had a panote Worker attached to them (see the cut-over step above); behavior under the actual
  consumer swap, retry, and DLQ path is unverified.
- **The real JWKS success path.** `packages/worker-kit/src/auth.ts`'s tests exercise the
  `globalThis.__verifyJwt` test seam (gated behind `env.TEST_JWT_SEAM === 'enabled'`, never set
  outside Vitest) and the rejection path for a missing/placeholder issuer. No test has ever
  fetched a real JWKS document or verified a real Auth0-issued token — that path is entirely
  unverified until a tenant exists and step 6 above can run.
