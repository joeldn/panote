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
# STATUS (2026-08-11): ported from pano-viewer's tiler-consumer, updated for
# panote's workspace names and pnpm 11. This image build has NOT been
# run/validated in panote — no Docker was run as part of this port. It was
# already unvalidated in the source (`pnpm deploy --legacy` is a pnpm-10
# idiom; whether pnpm 11 still accepts `--legacy` from a workspace without
# `inject-workspace-packages` is UNVERIFIED). Validate with the command above
# before the first deploy.

FROM node:24-slim AS build
RUN corepack enable
WORKDIR /repo
COPY . .
# Install the whole workspace, then build the consumer and its workspace deps.
RUN pnpm install --frozen-lockfile
RUN pnpm --filter "@service/tiler-consumer..." build
# Emit a self-contained deployable (dist + node_modules with workspace deps
# injected) into /out. --legacy is required for pnpm v10's deploy from a
# workspace without `inject-workspace-packages`; UNVERIFIED on pnpm 11.
RUN pnpm --filter "@service/tiler-consumer" --prod --legacy deploy /out

FROM node:24-slim
# sharp ships prebuilt libvips, but keep the system lib as a fallback.
RUN apt-get update \
  && apt-get install -y --no-install-recommends libvips42 \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /out/dist ./dist
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/package.json ./package.json
EXPOSE 8080
CMD ["node", "dist/container.js"]
