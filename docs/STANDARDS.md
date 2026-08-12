# Panote Engineering Standards

Design choices and best practices that apply across this monorepo.

---

## Node.js

- **Runtime:** Node 24 (latest stable LTS)
- **Version pinned** via `.nvmrc` at the repo root — always contains the major version only (e.g. `24`)
- Use `nvm use` when switching into the repo

---

## Package Manager

- **pnpm** — faster installs, strict dependency isolation, disk-efficient
- Single pnpm workspace at the repo root; every `apps/*`, `services/*`, `packages/*` is a workspace member
- Build scripts (install/postinstall hooks) are blocked by default. `strictDepBuilds: true` in `pnpm-workspace.yaml` fails the install if a dependency has a build script that isn't explicitly allowlisted — a new native dependency has to be a conscious decision, not something that silently runs code during install
- The allowlist is `allowBuilds` in `pnpm-workspace.yaml` — **not** `pnpm.onlyBuiltDependencies` in `package.json`. Currently allowlisted: `esbuild`, `sharp`, `workerd` (pulled in by Vite/Wrangler and the tiler's image pipeline)

---

## Dependencies

- **All dependencies pinned to exact versions — no `^` or `~` ranges**
- Keeps builds reproducible and makes upgrades explicit and intentional. A Worker deployed today should build identically in a year unless a version number changed on purpose
- Shared dependency versions live in a single pnpm catalog in `pnpm-workspace.yaml` — a version is written in exactly one place, and every workspace that needs it references the catalog entry (the literal string `"catalog:"`) instead of repeating the version
- To upgrade: change the version **in the catalog** (`pnpm-workspace.yaml`), not in any package's `package.json`, then run `pnpm install` — or let Renovate open the PR (`renovate.json5` sets `rangeStrategy: pin` and edits the catalog directly)
- Install governance, all configured in `pnpm-workspace.yaml`:

  | Flag | Value | What it does | Why |
  |---|---|---|---|
  | `catalogMode` | `strict` | Routes `pnpm add` through the catalog instead of writing a version straight into a package's `package.json` | Enforces "one place per version" above |
  | `savePrefix` | `''` | `pnpm add` writes an exact version into the catalog, never `^x.y.z` | **Non-obvious interaction:** `catalogMode: strict` only decides *where* the version string goes — it says nothing about its shape. Without `savePrefix: ''`, `pnpm add` would still happily write a caret range into the catalog entry itself. `savePrefix: ''` is what actually enforces "pinned exactly, no ranges" |
  | `cleanupUnusedCatalogs` | `true` | Drops catalog entries no package references any more | Stops the catalog rotting into a list of things we stopped using |
  | `dedupePeers` | `true` | Collapses peer dependency ranges to a single resolution where possible | Avoids installing several copies of the same peer |
  | `minimumReleaseAge` | `1440` (minutes, = 24h) | Refuses to install any package version published less than 24h ago | Blunt mitigation against a freshly-published compromised release |

---

## TypeScript

`@internal/typescript-config` ships four variants. Every workspace extends one of them by subpath — there is no single shared config that everything inherits directly, and `@tsconfig/recommended` is not used anywhere in this repo.

| Variant | For | Extends | Differs from `base.json` by |
|---|---|---|---|
| `base.json` | Node/library builds (`tsc -b`) | — | `types: ["node"]`; `module`/`moduleResolution: nodenext`; emits — `composite`, `declaration`, `declarationMap`, `sourceMap` all on |
| `workers.json` | Cloudflare Workers (`services/*`) | `base.json` | `types: []` (no `node` types — workerd isn't Node; ambient Worker types come from `@internal/worker-kit`'s shared `worker-configuration.d.ts` plus the package's own generated `env.d.ts`, both listed in the package's tsconfig `include`); `module: ESNext` / `moduleResolution: bundler`; `noEmit: true` — Wrangler/esbuild does the bundling, so `tsc` is type-check-only |
| `react.json` | Vite SPAs (`apps/*`) | `base.json` | `types: []` (apps supply their own ambient types, e.g. `vite/client`); `lib` adds `DOM`/`DOM.Iterable`; `jsx: react-jsx`; `module: ESNext` / `moduleResolution: bundler`; `noEmit: true` — Vite does the bundling |
| `tests.json` | Type-checking `*.test.ts` alongside a package's own `tsconfig.json` | — (combined via array `extends`, not layered on `base.json`) | `composite`, `incremental`, `declaration`, `declarationMap` all off; `noEmit: true`; `exclude: []` (clears the consuming package's own `"exclude": ["src/**/*.test.ts"]`) |

- `strict: true`, plus the stricter flags on top of it (`noUncheckedIndexedAccess`, `noImplicitOverride`, `exactOptionalPropertyTypes`, `noUnusedLocals`, etc.), are all set explicitly in `base.json`. Nothing is inherited from `@tsconfig/recommended` — that package isn't a dependency anywhere in this repo
- Target: `ES2023` across all four variants
- A workspace extends a variant by subpath, e.g. `"extends": "@internal/typescript-config/workers.json"`
- **Worker runtime types are generated by `wrangler types`, not taken from `@cloudflare/workers-types`** — Cloudflare superseded that package, and the generated types are binding-exact (a Durable Object namespace is typed `DurableObjectNamespace<TheClass>`, and only the vars that actually exist are declared). They are split into two committed files rather than generated whole per package: `wrangler types` emits ~14,700 lines of workerd runtime surface (`Request`, `R2Bucket`, `DurableObjectNamespace`, …) that is byte-identical across every Worker sharing a `compatibility_date`/`compatibility_flags`, plus a ~20-line per-Worker `Env` interface that differs. `@internal/worker-kit/src/worker-configuration.d.ts` is generated once (`wrangler types … --include-env=false`) and is the single committed copy of the runtime half — every `services/*` package already depends on `@internal/worker-kit`, so its tsconfig `include` also lists that file by relative path instead of generating its own copy. Each `services/*` package generates only its own `env.d.ts` (`wrangler types env.d.ts --env dev --strict-vars=false --include-runtime=false`) and lists both files in `include`; TypeScript's ambient global merging resolves `R2Bucket`/`DurableObjectNamespace`/etc. from the separately-included shared file, no imports needed. Gotchas: (1) both files must be listed in the package's tsconfig `include` or the runtime globals / `Env` don't resolve; (2) `env.d.ts` must be regenerated whenever a binding or var changes, and the shared runtime file whenever `compatibility_date`/`compatibility_flags` change (keep them in lockstep across every Worker — `wrangler types --check` verifies a file without rewriting it); (3) it is generated per `--env`, so it is generated from `dev` and `--strict-vars=false` keeps env-specific literal values out of the type — never compare a var against a string literal; (4) both files are excluded from the Prettier gate (tab-indented generated output) and self-exclude from ESLint via a leading `/* eslint-disable */` — `env.d.ts` needs an explicit ignore entry too, since the directive alone still trips `reportUnusedDisableDirectives` on generated output with zero real violations; (5) the test-only pool types (`@cloudflare/vitest-pool-workers/types`) go in `tsconfig.test.json`, and it must be the `/types` subpath — the bare package name yields `TS2305: Module '"cloudflare:test"' has no exported member 'SELF'`
- **Test files are type-checked separately from the build, via `tsc -p tsconfig.test.json` — never by widening the build `tsconfig.json`.** Every package's `tsconfig.json` excludes `src/**/*.test.ts` so `tsc -b` never emits a test file into `dist/`; the tradeoff on its own would mean `tsc -b` never type-checks test files either. Each package that has test files adds a sibling `tsconfig.test.json` that combines its own `tsconfig.json` with the shared `tests.json` overlay via TypeScript's array `extends` (package config first, `tests.json` second, so its `noEmit`/`exclude: []` overrides win): `"extends": ["./tsconfig.json", "@internal/typescript-config/tests.json"]`. The package's `typecheck` script then runs both, built on top of whatever it uses to typecheck `src/`: a `base.json`-derived package (`tsc -b`, emitting) runs `"typecheck": "tsc -b && tsc -p tsconfig.test.json"`; a `workers.json`-derived package (`tsc -p`, `noEmit: true` - `services/*`) runs `"typecheck": "tsc -p tsconfig.json && tsc -p tsconfig.test.json"` instead, since it has no project references to build. A package with no test files has no reason to add either file

---

## Linting & Formatting

- **ESLint** with flat config (`eslint.config.ts`)
  - `@eslint/js` recommended
  - `typescript-eslint` recommended
  - `eslint-config-prettier` to disable formatting rules that conflict with Prettier
- **Prettier** for all formatting
  - `singleQuote: true`
  - `tabWidth: 2`
  - `semi: true`
  - `trailingComma: "all"`
  - Run directly (`pnpm format` / `pnpm format:check`), not through ESLint — `eslint-config-prettier` only turns off the ESLint rules that would otherwise fight with it
  - **Markdown is excluded from the format gate** (`*.md` / `**/*.md` in `.prettierignore`). Prettier pads Markdown table columns to the width of the widest cell; the tables in `docs/` carry paragraph-length rationale, so padding them produces ~1500-character lines and re-flows the whole table on every edit. If a doc file looks unformatted, that's deliberate, not an oversight
- Scripts in every workspace `package.json`: `lint`, `lint:fix`, `typecheck`, `test`, `test:coverage`, `build` — run across the monorepo via `turbo run <script>`
- `format` and `format:check` are **root-only** scripts (`prettier --write .` / `prettier --check .` over the whole repo). No individual workspace has its own `format` script — Prettier isn't scoped per package
- **Every workspace's `lint` and `lint:fix` script passes `--max-warnings 0`.** Some rules (e.g. `no-console`) are deliberately configured at `'warn'`, not `'error'` — that severity is about how noisy the message is, not about whether it should block CI. Without `--max-warnings 0`, `eslint` exits `0` regardless of how many warnings it reports, so a warn-level rule could never fail the gate. `--max-warnings 0` makes any warning a lint failure, same as an error would be

---

## Scope Naming

Every workspace's `package.json` name declares two things at a glance: whether other workspaces may import it, and whether it deploys anywhere.

| Scope | Meaning | Location | Examples |
|---|---|---|---|
| `@panote/*` | May be published to the npm registry as a standalone package | `packages/` | `@panote/viewer`, `@panote/core` |
| `@internal/*` | Repo-only library — never published, may be imported by any other workspace | `packages/` | `@internal/contracts`, `@internal/worker-kit`, `@internal/api-client`, `@internal/tiler`, `@internal/typescript-config`, `@internal/eslint-config`, `@internal/vitest-config` |
| `@service/*` | Deployable Cloudflare Worker | `services/` | `@service/public-api`, `@service/admin-api`, `@service/upload-api`, `@service/tiler-consumer` |
| `@app/*` | Deployable frontend (Pages SPA) | `apps/` | `@app/website`, `@app/admin`, `@app/demo` |

If a workspace's scope doesn't match its directory, that's a bug — fix the scope, don't special-case the rule.

---

## Cloudflare Conventions

- **One Cloudflare account**, environments separated with Wrangler named environments (`[env.dev]`, `[env.production]`) inside a single `wrangler.jsonc` per Worker
- `dev` deploys to `panote.dev`, `production` deploys to `panote.io`
- Every dev-environment resource (KV namespace, R2 bucket, Durable Object class binding, Queue) carries a `-dev` suffix so dev and prod resources never collide in the same account
- **Gotcha — named environments do not inherit top-level config.** Wrangler does **not** carry top-level `vars`, `r2_buckets`, `durable_objects`, `queues`, or `containers` into an `[env.X]` block. Each named environment is its own complete config; anything you don't repeat under `[env.X]` silently does not exist in that environment. This has bitten us before as a Worker that ran fine locally (using top-level config) and then threw a binding-not-found error the moment it deployed under `--env dev`. Always define every binding under every environment block explicitly — don't rely on top-level values as defaults.

---

## Testing

- **Vitest** everywhere, workspaces run tests without a package-level watch mode in CI (`test` scripts run `vitest run`, not `vitest`)
- The shared config's `include` glob (`packages/vitest-config/src/base.ts`) matches both `src/**/*.{test,spec}.ts` and `test/**/*.{test,spec}.ts` — tests may be colocated with source or live in a sibling `test/` directory. There is no enforced `test/unit` / `test/integration` split
- `test` scripts run with `--passWithNoTests` — a workspace with no tests yet is not a CI failure, an empty test file is not something we write just to satisfy a runner
- **`@vitest/coverage-v8` does not work under `workerd`.** Coverage instrumentation needs Node's V8 inspector hooks, which the `workerd` runtime (used to run Worker tests) doesn't expose. `services/*` and any package tested against `workerd` run their tests without coverage. Coverage collection works for both the Node (`node.ts`) and browser/jsdom (`browser.ts`) Vitest config variants — it's only the `workerd`-tested packages that skip it

---

## Git Commits

- **One branch per unit of work** — never commit directly to `main`
- **Conventional Commits** standard — `type(scope): description`
- Common types: `feat`, `fix`, `chore`, `refactor`, `docs`, `test`, `ci`
- Subject line: short, imperative, no period — e.g. `feat(viewer): add pitch clamping`
- Keep commits logical and atomic — one concern per commit
- No "WIP", "misc fixes", or "updates" — every commit message should be meaningful on its own in `git log`
- **No co-author attributions in commit messages or PRs**
- Examples:
  ```
  feat(admin-api): add tour delete endpoint
  fix(public-api): return 404 instead of 500 for missing manifest
  chore(deps): bump wrangler to 3.90.0
  refactor(viewer): extract tile-loading into its own module
  docs(standards): document wrangler named-environment gotcha
  ci(tiler-consumer): add integration test for queue consumer
  ```
