# panote

Free hosted 360-degree panorama viewing and hosting. Upload an equirectangular
image, panote tiles it into a cube-face pyramid, and serves it through a
progressive multiresolution viewer — a low-res base layer covering the whole
panorama up front, streamed higher-resolution tiles as you pan and zoom.

Cloudflare-native: Workers, R2, Durable Objects, Queues, and Pages. No servers
to run.

## Repo layout

| Workspace | Scope | Purpose |
|---|---|---|
| `apps/website` | `@app/*` | Public marketing/viewing site (Pages) |
| `apps/admin` | `@app/*` | Authenticated admin UI for managing tours (Pages) |
| `apps/demo` | `@app/*` | Dev/verification app for the viewer package (Pages) |
| `services/public-api` | `@service/*` | Anonymous Worker — view/like/stats, owns the `TourStats` Durable Object |
| `services/admin-api` | `@service/*` | Fully authed Worker (Auth0 JWT) — tour management |
| `services/tiler-consumer` | `@service/*` | Queue consumer Worker — tiles uploaded panoramas |
| `services/upload-api` | `@service/*` | Authed Worker (Auth0 JWT) — presigned R2 upload URLs via the S3 API |
| `packages/viewer` | `@panote/*` | Publishable hand-rolled WebGL2 viewer library — no third-party runtime dependencies |
| `packages/core` | `@panote/*` | Publishable geometry/tiling/manifest primitives |
| `packages/tiler` | `@internal/*` | Panorama-to-tile-pyramid tiling logic |
| `packages/contracts` | `@internal/*` | Shared zod schemas — request validation and frontend form validation from one source of truth |
| `packages/worker-kit` | `@internal/*` | Shared Worker helpers (Hono setup, error handling, etc.) |
| `packages/typescript-config` | `@internal/*` | Shared `tsconfig` base |
| `packages/eslint-config` | `@internal/*` | Shared ESLint flat config |
| `packages/vitest-config` | `@internal/*` | Shared Vitest config |

See `docs/decisions.md` for why the repo is shaped this way.

## Prerequisites

- Node 24 (see `.nvmrc`; `nvm use`)
- pnpm

## Quickstart

```bash
pnpm install
pnpm build
pnpm test
pnpm lint
pnpm typecheck
pnpm format
```

## Docs

- `docs/STANDARDS.md` — conventions: package manager, dependency pinning, TypeScript, linting, testing, git commits, Cloudflare/Wrangler gotchas
- `docs/decisions.md` — architectural decisions and their rationale
- `docs/deploy.md` — provisioning and deploy runbook: what deploys where, one-time setup, first dev deploy checklist, production status
- `docs/CLAUDE.md` — pointer file for AI coding agents working in this repo

## Environments

One Cloudflare account, two Wrangler named environments:

| Environment | Domain |
|---|---|
| `dev` | panote.dev |
| `production` | panote.io |

Dev-environment resources (R2 buckets, Queues) carry a `-dev` suffix; Durable Object bindings and class names don't — they're fixed names namespaced by the script that declares them. See `docs/STANDARDS.md` for the details and a gotcha worth reading before you add a new binding, and `docs/deploy.md` for what's actually provisioned today.
