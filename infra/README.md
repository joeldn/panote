# Infrastructure

Everything panote runs on is in one Cloudflare account (dev on `panote.dev`, production on
`panote.io`) and one Auth0 tenant per environment (dev `panote-dev.au.auth0.com`, production not
made yet). Two tools manage them:

| What | Where | Applied by |
|---|---|---|
| R2 bucket, its CORS, r2.dev off, `cdn.<zone>` custom domain, upload → queue notification | `infra/pulumi` | `pulumi up` |
| Queues (`pano-uploads`, its DLQ), 14-day retention | `infra/pulumi` | `pulumi up` |
| Zone rulesets: WAF custom rules, rate limiting, cache rules, response headers, `www` redirect (production) | `infra/pulumi` | `pulumi up` |
| Zone settings: HSTS, URL normalization; the apex `AAAA 100::` record (and `www`, production) | `infra/pulumi` | `pulumi up` |
| Bucket CORS rules (the single source) | `infra/r2/cors.json` (`cors.dev.json`: dev plus localhost) | read by Pulumi |
| CDN cache rules (the single source) | `infra/cloudflare/cache-rules.<env>.json` | read by Pulumi |
| Auth0: the SPA both apps sign in with, the API (`https://api.<zone>`), the `google-oauth2` connection and the apps it serves, the password database switched off, Attack Protection | `infra/pulumi` (`src/auth0.ts`) | `pulumi up` |
| Auth0: the link-accounts M2M client and its Management API grant, the two post-login Actions, their secrets and their order in the Login flow | `infra/pulumi` (`src/auth0.ts`) | `pulumi up` |
| The Actions' code (the single source, deployed as it is) | `packages/auth0-actions/src/*.cjs` | read by Pulumi |
| Workers, their routes, bindings, secrets | `services/*`, `apps/*` `wrangler.jsonc` | wrangler, `deploy.yml` |

Not managed here yet: API tokens, billing usage alerts, GitHub settings, Cloudflare Access (dev),
Email Routing (production). In Auth0: the tenants themselves and Pulumi's own clients in them
(step 11), any connection other than Google and the password database (Apple, Microsoft, Facebook
and email codes don't exist on either tenant yet), the email provider, Universal Login branding.
See [`docs/deploy.md`](../docs/deploy.md) for those.

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
  `panote-tiles-404-no-store` that production uses;
- **update** `hsts`: `max_age` 15552000 → 31536000, one year, the same as the apps' own
  `Strict-Transport-Security` header.

A ruleset's name is ignored (`ignoreChanges`), so a dashboard name other than `default` never
shows up. Anything else (a changed expression, another HSTS value, a queue setting, a **replace**
or **delete** of anything) means the code and the account disagree: fix whichever is wrong and
preview again. Don't `up` past it.

### 9. Up

The custom domain and the notification already exist on dev but can't be imported: creating the
domain fails while it's attached, and the notification could end up doubled. So everything else
goes first, and those two are only removed and recreated once that has worked.

```bash
cd infra/pulumi
export CLOUDFLARE_API_TOKEN=<bootstrap token>
DOMAIN='urn:pulumi:dev::panote-infra::cloudflare:index/r2CustomDomain:R2CustomDomain::cdn-domain'
NOTIFY='urn:pulumi:dev::panote-infra::cloudflare:index/r2BucketEventNotification:R2BucketEventNotification::upload-notification'
pulumi preview --stack dev --urns          # the two URNs above must appear as written
```

a. Everything but those two. Dev keeps its live domain and notification meanwhile:
   ```bash
   pulumi up --stack dev --diff --exclude "$DOMAIN" --exclude "$NOTIFY"
   ```
   Check dev still works before going on: the CDN checks in docs/deploy.md ("Prerequisite: WAF
   custom rule": private paths `403`, `/tiles/x` `404`, a real tile `200`), a page load on
   `panote.dev`, and the nosniff and CSP headers on `curl -sI https://cdn.panote.dev/tiles/x`.
b. Only then remove the two live ones (from the repo root):
   ```bash
   pnpm --filter @service/admin-api exec wrangler r2 bucket notification delete pano-content-dev --queue pano-uploads-dev
   pnpm --filter @service/admin-api exec wrangler r2 bucket domain remove pano-content-dev --domain cdn.panote.dev --force
   ```
c. Recreate them right away (back in `infra/pulumi`):
   ```bash
   pulumi up --stack dev --diff --target "$DOMAIN" --target "$NOTIFY"
   ```
d. Confirm nothing is left:
   ```bash
   pulumi preview --stack dev --expect-no-changes
   pulumi stack export --stack dev --file <somewhere safe>/panote-dev-state.json
   ```

Between b and c the CDN is down for minutes, mostly waiting for the custom domain's certificate
to be issued, and uploads don't tile, so pick a quiet moment. Check
`wrangler r2 bucket notification list pano-content-dev` shows one rule (`panos/` / `/original`)
and `cdn.panote.dev` serves again. A pano uploaded in the gap has its original but no tiles:
re-queue it with `services/admin-api/scripts/retile.ts --pano <panoId> --apply` (docs/deploy.md,
Re-tiling).

The rate-limit rule uses the Free plan's limits as documented, but only an `up` shows whether
Cloudflare accepts the expression shape on this plan. If it refuses it, the error names what it
rejected; adjust `rateLimitRules` in `src/rules.ts` and run a again.

### 10. Production from scratch

Production has nothing yet, so there is nothing to import. This replaces Production runbook steps
1-7 in docs/deploy.md. Its stack file names no Auth0 tenant yet, so this `up` touches Cloudflare
only; the tenant follows in step 16.

```bash
cd infra/pulumi
pulumi stack init production --secrets-provider passphrase   # commit the encryptionsalt line
pulumi preview --stack production --diff                       # creates only
pulumi up --stack production --diff
pulumi stack output zoneId --stack production                  # CDN_ZONE_ID for runbook step 10
pulumi stack export --stack production --file <somewhere safe>/panote-production-state.json
```

The preview must show `location: "enam"` on `content-bucket`. R2 reads the hint only when the
bucket is created and never moves it afterwards, so check it before the first `up`. Afterwards,
`wrangler r2 bucket info pano-content` shows where the bucket ended up (the hint is best effort).

The custom domain waits for the WAF rules in the code (`dependsOn`), so `cdn.panote.io` is never
reachable without them. Then run runbook step 6's checks and the rest of the runbook (Auth0 in
step 16 below, secrets, placeholders, deploy).

## Auth0

`src/auth0.ts` declares each tenant once its stack file names it (`auth0:domain`, the provider's
own key, so the program and the provider can't point at two tenants). Neither file names one
yet, so until step 13 (dev) or 16 (production) the program touches nothing in Auth0 and needs no
Auth0 credentials; steps 1-10 run exactly as written. Do dev's Cloudflare side (steps 7-9) first.
The Actions' code is read from `packages/auth0-actions/src` at every run, so a change to an
Action ships with `pulumi up`, not a paste. `pulumi up` owns what it declares: a change made in the dashboard to any of it
(an Action's code or secrets, the Login flow's order, which apps use Google) is drift, and the
next `up` undoes it.

### 11. Pulumi's Auth0 clients (once per tenant)

Pulumi calls the tenant's Management API as a Machine to Machine application in that tenant. Make
two, like the two Cloudflare tokens: dashboard → Applications → Create Application → Machine to
Machine, name `pulumi` (and `pulumi-read`), authorise it for the *Auth0 Management API* with:

| Scopes | `pulumi` (`up`, `import`) | `pulumi-read` (`import-file-auth0`, CI preview) |
|---|---|---|
| `read:clients` | yes | yes |
| `create:clients`, `update:clients`, `delete:clients` | yes | no |
| `read:client_keys` | yes (the link-accounts client's secret, which its Action gets) | no |
| `update:client_keys` | yes (*unverified*: setting a client's authentication method) | no |
| `read:client_grants` | yes | yes |
| `create:client_grants`, `update:client_grants`, `delete:client_grants` | yes | no |
| `read:resource_servers` | yes | yes |
| `create:resource_servers`, `update:resource_servers`, `delete:resource_servers` | yes | no |
| `read:connections` | yes | yes |
| `create:connections`, `update:connections`, `delete:connections` | yes | no |
| `read:actions` | yes | yes |
| `create:actions`, `update:actions`, `delete:actions` | yes | no |
| `read:attack_protection` | yes | yes |
| `update:attack_protection` | yes | no |

*(unverified)* This list follows each resource's API. A refusal names the scope it wanted
(`Insufficient scope, expected any of: …`); add it here. Never authorise either client for
Panote's own API. The program doesn't manage these two (a client can't safely manage itself).

Pulumi reads the client from the environment; the tenant always comes from the stack. Keep
`AUTH0_DOMAIN` unset:

```bash
export AUTH0_CLIENT_ID=<the pulumi client's id>
export AUTH0_CLIENT_SECRET=<its secret>
```

Like the bootstrap Cloudflare token, keep the `pulumi` client's secret out of shells that don't
need it, and rotate it (the client's Credentials tab) after use.

### 12. Config

| Key | How | dev | production |
|---|---|---|---|
| `auth0:domain` | `Pulumi.<stack>.yaml` | `panote-dev.au.auth0.com`, set in step 13 | the new tenant's, step 16 |
| `panote-infra:auth0LocalDevCallbacks` | `Pulumi.<stack>.yaml` | `true` (the localhost callbacks in docs/deploy.md, Local dev) | refused |
| `panote-infra:googleClientId` | `Pulumi.<stack>.yaml` | unset: Auth0's developer keys | required |
| `panote-infra:googleClientSecret` | `pulumi config set --secret` | with `googleClientId` only | required |
| `panote-infra:bannedEmailSha256` | `pulumi config set --secret` | optional | optional |

A dev tenant's name ends in `-dev` and production's never does; the program refuses the other
way round. Set a secret without putting it on the command line (it prompts), and commit the
stack file: it holds only the ciphertext.

```bash
cd infra/pulumi
pulumi config set --stack dev --secret googleClientSecret
```

**The ban list** (docs/deploy.md, "Email ban list") is `bannedEmailSha256`: the hashes
`ban-email.cjs` prints, comma-separated. The program refuses an entry that isn't a hash, without
printing it. Unset means nobody is refused.

```bash
node packages/auth0-actions/scripts/ban-email.cjs 'person@example.com'   # prints the hash
cd infra/pulumi
pulumi config get --stack dev bannedEmailSha256        # the list so far (an error if there's none)
pulumi config set --stack dev --secret bannedEmailSha256   # paste it back with the new hash added
pulumi preview --stack dev --diff                      # only the ban-list Action's secrets change
pulumi up --stack dev --diff
```

### 13. Import dev's Auth0

Dev was set up by hand, like its Cloudflare side. `import-file-auth0` finds each resource by what
the repo already says about it and writes `infra/pulumi/import.auth0.dev.json` (GETs only, after
the token request):

- the SPA: the client id in `apps/admin/.env.dev` and `apps/website/.env.dev` (they must agree);
- the API: its identifier, `https://api.panote.dev`;
- the `google-oauth2` connection and `Username-Password-Authentication` (whose enabled apps the
  program sets), by name;
- the M2M client named `link-accounts action` and its Management API grant;
- the Actions `Block banned emails` and `Link accounts by verified email`, by name;
- the post-login bindings and Attack Protection, which every tenant has.

```bash
cd infra/pulumi
pulumi config set --stack dev auth0:domain panote-dev.au.auth0.com   # commit Pulumi.dev.yaml with the PR below
cd ../..
export AUTH0_CLIENT_ID=<pulumi-read id> AUTH0_CLIENT_SECRET=<its secret>
pnpm --filter @internal/infra build
pnpm --filter @internal/infra run import-file-auth0 dev   # from the repo root; prints what it found
export AUTH0_CLIENT_ID=<pulumi id> AUTH0_CLIENT_SECRET=<its secret>
cd infra/pulumi
pulumi import --stack dev --file import.auth0.dev.json --generate-code=false --protect=false
```

Import with the `pulumi` client, not `pulumi-read`: without `read:client_keys` the provider reads
the link-accounts client's secret as an empty string, and the program then stops rather than give
the Action an empty secret. If that happens, re-run the import's refresh with the right client:
`pulumi refresh --stack dev --target 'urn:pulumi:dev::panote-infra::auth0:index/clientCredentials:ClientCredentials::auth0-link-accounts-credentials'`.

Commit the `auth0:domain` line in a PR of its own (the tests check it names the dev tenant).
Until that PR merges, CI previews dev without Auth0.

If the script lists something as `create` that dev has under another name (an Action, or the M2M
client named differently), rename it in the dashboard and run the script again; otherwise `up`
makes a second one and the old one stays behind, unbound.

What the provider can't import: an Action's secrets (Auth0 never returns them), so `up` writes all
of them. Nothing in the Auth0 program is replaced on a first `up` if the names below match; the
program protects the SPA, the API and the Google connection anyway (`protect: true`): a new SPA is
a new client id the built apps don't know, a new API identifier invalidates every token, and
deleting a connection deletes every user who signed in through it.

### 14. Preview: what to expect

```bash
pulumi preview --stack dev --diff
```

Before reading it, two values the import can't see:

- **Google.** If dev's `google-oauth2` connection has its own Google client (dashboard →
  Authentication → Social → google-oauth2 shows a Client ID), set `googleClientId` and
  `googleClientSecret` (step 12) first, or `up` puts it back on Auth0's developer keys.
- **The ban list.** Auth0 doesn't show a secret's value. If dev's `BANNED_EMAIL_SHA256` holds any
  hashes, set `bannedEmailSha256` from the case log first, or `up` empties it.

Then these and only these are expected, all **update**:

- `auth0-ban-list-action`, `auth0-link-accounts-action`: `secrets` (always: the import can't read
  them) and `code` (the comment at the top of both files changed with this program; any older
  paste too). Each update deploys a new version of the Action;
- `auth0-post-login-actions`: only if the Login flow isn't exactly *Block banned emails*, then
  *Link accounts by verified email*, nothing else;
- `auth0-database-clients`: `enabledClients` to none, if the SPA still had the password database
  (a new tenant enables it for every app). Nobody could have a Panote account through it on
  purpose, but check User Management → Users for `auth0|…` users first;
- `auth0-google`: `options` down to `scopes: [email, profile]` (and the client, if set);
  anything else the dashboard stored on it goes;
- `auth0-spa`: `name` (`Panote`), `webOrigins`, `grantTypes`, `refreshToken` lifetimes,
  wherever the dashboard differs; `auth0-api`: `name` (`Panote API`) and consent skipping;
- `auth0-link-accounts-client`: `description`;
- `auth0-attack-protection`: to the thresholds in `src/auth0.ts`.

A **replace** or **delete** of anything, or an update to `auth0-api`'s identifier,
`auth0-google`'s name or strategy, or an Action's trigger, means the code and the tenant
disagree: stop and fix whichever is wrong.

### 15. Up dev

Every change is in place: nothing goes down while it runs.

```bash
pulumi up --stack dev --diff
pulumi preview --stack dev --expect-no-changes
pulumi stack export --stack dev --file <somewhere safe>/panote-dev-state.json
```

Then check: sign in with Google on `https://panote.dev/?signin=1` and land on `/app/`; the
Action's logs (Monitoring → Logs) show both Actions ran; `https://panote-dev.au.auth0.com/authorize?client_id=<SPA id>&response_type=code&redirect_uri=https://panote.dev/app/callback&connection=Username-Password-Authentication`
ends in an error, not a password form; Security → Attack Protection shows the three on.

*(unverified)* Whether a free-plan tenant accepts breached-password detection only an `up` shows.
If it refuses, the error names the setting; set `enabled: false` for it in `ATTACK_PROTECTION`
(`src/auth0.ts`) and run `up` again. It only guards password logins, which Panote doesn't offer.

### 16. Production's tenant from scratch

This replaces Production runbook step 8 in docs/deploy.md.

1. Create the tenant by hand (dashboard → tenant menu → Create tenant): a name that doesn't end
   in `-dev`, in the **US** region (it can't be changed later, and US is closest to the `enam`
   bucket; docs/deploy.md, runbook step 8). Its domain is then `<name>.us.auth0.com`. Make step
   11's two clients in it.
2. In Google Cloud, the OAuth consent screen and Web client from runbook step 8, with redirect URI
   `https://<tenant domain>/login/callback`.
3. Point the stack at them and commit `Pulumi.production.yaml`:
   ```bash
   cd infra/pulumi
   pulumi config set --stack production auth0:domain <tenant domain>
   pulumi config set --stack production googleClientId <client id>
   pulumi config set --stack production --secret googleClientSecret
   ```
4. Nothing to import: the bindings, Attack Protection and the password database's apps already
   exist on a new tenant, and `up` just writes them.
   ```bash
   export AUTH0_CLIENT_ID=<production pulumi id> AUTH0_CLIENT_SECRET=<its secret>
   pnpm --filter @internal/infra build
   pulumi preview --stack production --diff        # creates only, nothing in Cloudflare changes
   pulumi up --stack production --diff
   pulumi stack output auth0SpaClientId --stack production   # VITE_AUTH0_CLIENT_ID
   pulumi stack output auth0Issuer --stack production        # OAUTH_ISSUER
   pulumi stack export --stack production --file <somewhere safe>/panote-production-state.json
   ```
5. Runbook step 8's check (`.well-known/openid-configuration`), then step 10 with the two outputs.

## CI preview

`.github/workflows/infra-preview.yml` runs `pulumi preview` for both stacks on a pull request that
touches `infra/`. It reads these secrets from the `infra-preview` GitHub Environment and ends with a
notice while any is missing:

- `PULUMI_BACKEND_URL`: the `s3://…` URL from step 4;
- `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`: the state bucket token (preview takes the stack's lock, so Read & Write);
- `PULUMI_CONFIG_PASSPHRASE`;
- `CLOUDFLARE_API_TOKEN`: the read token from step 3, never the bootstrap one;
- `AUTH0_CLIENT_ID_DEV`, `AUTH0_CLIENT_SECRET_DEV` (and `..._PRODUCTION` once that tenant
  exists): each tenant's `pulumi-read` client from step 11. A stack whose file names a tenant
  previews only with its pair; without it, that stack's job ends with a notice.

`pulumi preview` runs the pull request's own program with these secrets: anyone who can push a
branch could change that program to read them. The workflow keeps them off the install and build
steps, but that doesn't change this, so before adding the secrets (manual, once):

- give the `infra-preview` environment **required reviewers** (Settings → Environments →
  `infra-preview`), or a deployment-branch rule, so a run only gets them once approved;
- make `CLOUDFLARE_API_TOKEN` the read token, never one that can edit, and the Auth0 pairs the
  `pulumi-read` clients;
- scope the R2 key to `panote-pulumi-state` only.

A fork's pull request gets no secrets.

## Changing things

- Edit the code, `cors.json`, a `cache-rules.<env>.json` or an Action in
  `packages/auth0-actions/src`, `pnpm --filter @internal/infra build`,
  `pulumi preview --stack dev --diff`, then `up`. Same for production.
- Tests (`pnpm --filter @internal/infra test`) run the program against Pulumi's mocks and pin the
  rule expressions, HSTS, retention and names, the SPA's URLs, the audience and issuer against the
  apps' and APIs' config, the linking grant's scopes and the order of the Login flow.
- `error: the stack is currently locked`: a run was killed before releasing its lock in the state
  bucket. Check nothing else is running, then `pulumi cancel --stack <stack>` and retry. *(unverified
  against R2)*
- HSTS is zone-wide with `includeSubdomains` (one year): any future subdomain served over plain
  HTTP would be unreachable in browsers that saw it. Mail is unaffected (HSTS is HTTP only).
- A change made in the dashboard is drift: `pulumi preview --refresh` shows it, and the next `up`
  undoes it. Make the change in code instead.
- Fallback when Pulumi can't be used: the wrangler commands and dashboard steps in docs/deploy.md
  (One-time provisioning) still describe every resource. Bring the code back in line afterwards.
