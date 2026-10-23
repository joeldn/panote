# Infrastructure

Everything panote runs on is in one Cloudflare account (dev on `panote.dev`, production on
`panote.io`). Two tools manage it:

| What | Where | Applied by |
|---|---|---|
| R2 bucket, its CORS, r2.dev off, `cdn.<zone>` custom domain, upload → queue notification | `infra/pulumi` | `pulumi up` |
| Queues (`pano-uploads`, its DLQ), 14-day retention | `infra/pulumi` | `pulumi up` |
| Zone rulesets: WAF custom rules, rate limiting, cache rules, response headers, `www` redirect (production) | `infra/pulumi` | `pulumi up` |
| Zone settings: HSTS, URL normalization; the apex `AAAA 100::` record (and `www`, production) | `infra/pulumi` | `pulumi up` |
| Bucket CORS rules (the single source) | `infra/r2/cors.json` (`cors.dev.json`: dev plus localhost) | read by Pulumi |
| CDN cache rules (the single source) | `infra/cloudflare/cache-rules.<env>.json` | read by Pulumi |
| Workers, their routes, bindings, secrets | `services/*`, `apps/*` `wrangler.jsonc` | wrangler, `deploy.yml` |

Not managed here yet: API tokens, billing usage alerts, Auth0, GitHub settings, Cloudflare Access
(dev), Email Routing (production). See [`docs/deploy.md`](../docs/deploy.md) for those.

The Pulumi program is `infra/pulumi` (`@internal/infra`), one project `panote-infra`, stacks
`dev` and `production`. Their non-secret settings are `infra/pulumi/Pulumi.<stack>.yaml`. State
lives in a private R2 bucket, `panote-pulumi-state`, that the program does not manage.

**Never** run `pulumi up` without reading `pulumi preview` first. CI only previews (`.github/workflows/infra-preview.yml`), it never applies.

## Install and run

Every command runs from the repo root unless it says `cd`. Lines marked *(unverified)* could not
be run against a real account when this was written; the rest were checked against the pinned
CLI's `--help`, or offline.

### 1. Prerequisites

```bash
nvm use                                   # Node 24, from .nvmrc
corepack enable                           # pnpm 11.20.0, from package.json "packageManager"
pnpm install --frozen-lockfile
pnpm --filter @internal/infra build       # the program runs from infra/pulumi/dist
curl -fsSL https://get.pulumi.com | sh -s -- --version 3.268.0   # (unverified here)
pulumi version                            # v3.268.0, the same as @pulumi/pulumi in pnpm-workspace.yaml
```

Rebuild (`pnpm --filter @internal/infra build`) after every change under `infra/pulumi/src`: Pulumi runs
the built `dist/`, not `src/`.

### 2. The state bucket and its R2 token (once)

1. Create the bucket (any wrangler works; this one is a devDependency of every service):
   ```bash
   pnpm --filter @service/admin-api exec wrangler r2 bucket create panote-pulumi-state
   ```
   Leave it private: no custom domain, no r2.dev URL.
2. Dashboard → R2 → **Manage API tokens** → **Create Account API token**: permission **Object
   Read & Write**, **Apply to specific buckets only** → `panote-pulumi-state`. Keep the Access
   Key ID and Secret Access Key.

R2 has no object versioning. After each `pulumi up`, keep a copy:
`pulumi stack export --stack <stack> --file <somewhere safe>`.

### 3. The Cloudflare API tokens

Two custom tokens (My Profile → API Tokens → Create Custom Token), account
`12e2809e05de8a2bf20b815fd394ec9a`, zones `panote.dev` and `panote.io`:

| Permission | Bootstrap token (`pulumi up`) | Read token (`import-file`, CI preview) |
|---|---|---|
| Account → Workers R2 Storage | Edit | Read |
| Account → Queues | Edit | Read |
| Zone → Zone | Read | Read |
| Zone → Zone Settings | Edit | Read |
| Zone → DNS | Edit | Read |
| Zone → Zone WAF | Edit | Read |
| Zone → Cache Rules | Edit | Read |
| Zone → Transform Rules | Edit | Read |
| Zone → Dynamic URL Redirects (Single Redirects) | Edit | Read |

*(unverified)* This list follows each resource's API. If a call fails with `10000
Authentication error`, the failing request names the missing permission; add it here.

Keep the bootstrap token out of shells you don't need it in; give it a short TTL and roll it after
use.

### 4. Log in to the state backend

```bash
export AWS_ACCESS_KEY_ID=<state bucket key id>          # from step 2
export AWS_SECRET_ACCESS_KEY=<state bucket secret>
pulumi login 's3://panote-pulumi-state?endpoint=https://12e2809e05de8a2bf20b815fd394ec9a.r2.cloudflarestorage.com&region=auto&use_path_style=true'
```

The query parameters were checked against the 3.268.0 CLI's S3 driver (an unknown one is
rejected); the connection to R2 itself is *(unverified)*. `PULUMI_BACKEND_URL` set to the same URL
works instead of `pulumi login` (CI uses that).

### 5. The passphrase

The stacks encrypt their secrets with a passphrase (`--secrets-provider passphrase`). Generate it
once and **store it in your password manager**: without it nothing in the stacks can be read or
changed again, and the only way back is new stacks and a fresh import.

```bash
openssl rand -base64 32                   # once; save it in the password manager
export PULUMI_CONFIG_PASSPHRASE=<it>
```

### 6. Create or select the stack

```bash
cd infra/pulumi
pulumi stack init dev --secrets-provider passphrase       # once; later: pulumi stack select dev
pulumi config --stack dev                                  # shows Pulumi.dev.yaml's settings
```

`stack init` adds an `encryptionsalt:` line to `Pulumi.dev.yaml`. Commit it.

### 7. Import dev

Dev was built by hand, so its resources go into the state before the first `up`.
`import-file` reads their ids from the API (GETs only) and writes `infra/pulumi/import.dev.json`
with the program's own logical names (`src/names.ts`), so each one lands on the resource the code
declares. This is why it's a generated file and not `import` options in the code: no ids are
pasted by hand, nothing has to be removed from the code afterwards, and the import only touches
state.

```bash
export CLOUDFLARE_API_TOKEN=<read token>
pnpm --filter @internal/infra run import-file dev    # from the repo root; prints what it found
cd infra/pulumi
pulumi import --stack dev --file import.dev.json --generate-code=false --protect=false
```

The code itself protects the bucket and both queues (`protect: true`).

<details>
<summary>The same, by hand</summary>

```bash
ACCOUNT=12e2809e05de8a2bf20b815fd394ec9a
ZONE=2196d8dead0322ad69307711fc72b5d3      # panote.dev: dashboard → the zone's Overview → API → Zone ID
cf() { curl -fsS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" "https://api.cloudflare.com/client/v4$1"; }
imp() { pulumi import --stack dev --generate-code=false --protect=false --yes "$@"; }

imp cloudflare:index/r2Bucket:R2Bucket content-bucket "$ACCOUNT/pano-content-dev/default"
# Queue ids: dashboard → Queues → the queue → Settings, or
cf "/accounts/$ACCOUNT/queues" | jq -r '.result[] | "\(.queue_name) \(.queue_id)"'
imp cloudflare:index/queue:Queue uploads-queue "$ACCOUNT/<pano-uploads-dev id>"
imp cloudflare:index/queue:Queue uploads-dlq "$ACCOUNT/<pano-uploads-dlq-dev id>"
# Each ruleset: a 404 means the phase has no rules yet; skip it, up creates it.
for phase in http_request_firewall_custom http_ratelimit http_request_cache_settings http_response_headers_transform; do
  echo "$phase $(cf "/zones/$ZONE/rulesets/phases/$phase/entrypoint" | jq -r .result.id)"; done
imp cloudflare:index/ruleset:Ruleset waf-custom-rules "zones/$ZONE/<http_request_firewall_custom id>"
imp cloudflare:index/ruleset:Ruleset rate-limit-rules "zones/$ZONE/<http_ratelimit id>"
imp cloudflare:index/ruleset:Ruleset cache-rules "zones/$ZONE/<http_request_cache_settings id>"
imp cloudflare:index/ruleset:Ruleset response-header-rules "zones/$ZONE/<http_response_headers_transform id>"
imp cloudflare:index/zoneSetting:ZoneSetting hsts "$ZONE/security_header"
imp cloudflare:index/urlNormalizationSettings:UrlNormalizationSettings url-normalization "$ZONE"
cf "/zones/$ZONE/dns_records?type=AAAA&name.exact=panote.dev" | jq -r '.result[].id'
imp cloudflare:index/dnsRecord:DnsRecord apex-aaaa "$ZONE/<record id>"
```

</details>

Four resources have no import in the provider: `content-bucket-cors`, `content-bucket-r2-dev-domain`,
`cdn-domain` and `upload-notification`. The first `up` writes them (step 9).

### 8. Preview: no unexplained changes

```bash
pulumi preview --stack dev --diff
```

After the import, these and only these are expected:

- **create** the four resources above;
- **create** `rate-limit-rules` if the zone had no rate-limiting rule yet;
- **update** the imported rulesets where the dashboard's rules differ from the code: refs and
  descriptions (dashboard rules carry generated ones), rules the code adds that aren't live yet (the CDN
  nosniff/CSP headers, `panote-json-edge-cache` if it was never applied), and
  `tiles-404-short-ttl`, the dashboard cache rule, replaced by the same-purpose
  `panote-tiles-404-no-store` that production uses.

Anything else (a changed expression, an HSTS value, a queue setting, a **replace** or **delete**
of anything) means the code and the account disagree: fix whichever is wrong and preview again.
Don't `up` past it.

### 9. Up

The two adopted resources that already exist need clearing first, once, on dev only: creating the
custom domain fails while it's attached, and the notification could end up doubled. Both are
recreated seconds later by the same `up`. Uploads in that window don't tile, and the CDN is down
until its certificate is reissued, so pick a quiet moment.

```bash
pnpm --filter @service/admin-api exec wrangler r2 bucket notification delete pano-content-dev --queue pano-uploads-dev
pnpm --filter @service/admin-api exec wrangler r2 bucket domain remove pano-content-dev --domain cdn.panote.dev --force
cd infra/pulumi
export CLOUDFLARE_API_TOKEN=<bootstrap token>
pulumi up --stack dev --diff
pulumi preview --stack dev --expect-no-changes     # must now pass
pulumi stack export --stack dev --file <somewhere safe>/panote-dev-state.json
```

Then check the CDN as in docs/deploy.md ("Prerequisite: WAF custom rule": private paths `403`,
`/tiles/x` `404`) and `wrangler r2 bucket notification list pano-content-dev` (one rule,
`panos/` / `/original`).

### 10. Production from scratch

Production has nothing yet, so there is nothing to import. This replaces Production runbook steps
1-7 in docs/deploy.md.

```bash
cd infra/pulumi
pulumi stack init production --secrets-provider passphrase   # commit the encryptionsalt line
pulumi preview --stack production --diff                       # creates only
pulumi up --stack production --diff
pulumi stack output zoneId --stack production                  # CDN_ZONE_ID for runbook step 10
pulumi stack export --stack production --file <somewhere safe>/panote-production-state.json
```

The custom domain waits for the WAF rules in the code (`dependsOn`), so `cdn.panote.io` is never
reachable without them. Then run runbook step 6's checks and the rest of the runbook (Auth0,
secrets, placeholders, deploy).

## CI preview

`.github/workflows/infra-preview.yml` runs `pulumi preview` for both stacks on a pull request that
touches `infra/`. It reads these secrets from the `infra-preview` GitHub Environment and ends with a
notice while any is missing:

- `PULUMI_BACKEND_URL`: the `s3://…` URL from step 4;
- `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`: the state bucket token (preview takes the stack's lock, so Read & Write);
- `PULUMI_CONFIG_PASSPHRASE`;
- `CLOUDFLARE_API_TOKEN`: the read token from step 3, never the bootstrap one.

`pulumi preview` runs the pull request's own program with these secrets: anyone who can push a
branch could change that program to read them. The workflow keeps them off the install and build
steps, but that doesn't change this, so before adding the secrets (manual, once):

- give the `infra-preview` environment **required reviewers** (Settings → Environments →
  `infra-preview`), or a deployment-branch rule, so a run only gets them once approved;
- make `CLOUDFLARE_API_TOKEN` the read token, never one that can edit;
- scope the R2 key to `panote-pulumi-state` only.

A fork's pull request gets no secrets.

## Changing things

- Edit the code, `cors.json` or a `cache-rules.<env>.json`, `pnpm --filter @internal/infra build`,
  `pulumi preview --stack dev --diff`, then `up`. Same for production.
- Tests (`pnpm --filter @internal/infra test`) run the program against Pulumi's mocks and pin the
  rule expressions, HSTS, retention and names.
- `error: the stack is currently locked`: a run was killed before releasing its lock in the state
  bucket. Check nothing else is running, then `pulumi cancel --stack <stack>` and retry. *(unverified
  against R2)*
- HSTS is zone-wide with `includeSubdomains` (6 months): any future subdomain served over plain
  HTTP would be unreachable in browsers that saw it. Mail is unaffected (HSTS is HTTP only).
- A change made in the dashboard is drift: `pulumi preview --refresh` shows it, and the next `up`
  undoes it. Make the change in code instead.
- Fallback when Pulumi can't be used: the wrangler commands and dashboard steps in docs/deploy.md
  (One-time provisioning) still describe every resource. Bring the code back in line afterwards.
