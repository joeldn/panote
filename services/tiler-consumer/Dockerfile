# Container image for the pano tiler.
#
# The consumer's container entrypoint (src/container.ts) imports workspace
# packages (@internal/tiler, @internal/contracts, @internal/worker-kit) and
# the native `sharp` dep, so the image must vendor resolved node_modules — a
# bare `pnpm install` of this one package's manifest cannot resolve
# `workspace:*` deps. We build from the MONOREPO ROOT and use `pnpm deploy`
# to emit a self-contained bundle.
#
# Build (context = repo root):
#   docker build -f services/tiler-consumer/Dockerfile -t panote-tiler .
#
# STATUS (2026-08-12): built and exercised with Docker 29.4.0 on an x86_64
# host (pnpm 11.20.0, node:24-slim = node v24.19.0).
# VERIFIED: the build command above succeeds; the image's node_modules has no
# dangling symlinks and resolves @internal/contracts, @internal/tiler,
# @internal/worker-kit, @panote/core, sharp, zod and aws4fetch; sharp runs a
# real decode/resize/encode round trip in-image (libvips 8.16.1, linux-x64
# prebuilt); the entrypoint exits 1 naming each missing R2_* var, and with all
# four present it listens on 8080; POST /tile against an S3-compatible
# endpoint wrote 6 cube faces + manifest.json at both maxLevel 0 and
# maxLevel 1.
# UNVERIFIED: the arm64 cross-build (this host is x86_64 — the --platform pins
# below are what force amd64 there); the Queue consumer Worker and the
# @cloudflare/containers DO lifecycle, which need wrangler/Cloudflare; and any
# run against real Cloudflare R2.

FROM --platform=linux/amd64 node:24-slim AS build
RUN corepack enable
WORKDIR /repo
COPY . .
# Install the whole workspace, then build the consumer and its workspace deps.
RUN pnpm install --frozen-lockfile
RUN pnpm --filter "@service/tiler-consumer..." build
# Emit a deployable (dist + fully resolved node_modules) into /out.
# --config.inject-workspace-packages=true is scoped to THIS command only: it
# makes deploy copy the workspace deps into /out instead of symlinking them
# back into /repo, which the runtime stage never copies. The default (v10+)
# refuses outright with ERR_PNPM_DEPLOY_NONINJECTED_WORKSPACE, and --legacy
# "succeeds" while emitting those dangling symlinks — a green build that dies
# on the first import. The flag does not touch the root install above, the
# lockfile, or pnpm-workspace.yaml.
RUN pnpm --filter "@service/tiler-consumer" --config.inject-workspace-packages=true --prod deploy /out

FROM --platform=linux/amd64 node:24-slim
# No apt packages: sharp ships its own prebuilt libvips (8.16.1) and never
# dlopens the system one. Debian's libvips42 (8.14.1) was ~156 MB of dead
# weight and is deliberately not installed.
WORKDIR /app
COPY --from=build /out/dist ./dist
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/package.json ./package.json
EXPOSE 8080
CMD ["node", "dist/container.js"]
