# syntax=docker/dockerfile:1.7
#
# The panel: the static build and a small server that makes `/config.json` from the environment at
# start, so one image runs against any Control API (see docs/runbooks/deploy-gcp.md for the table).
#
#   docker build -f packages/panel/Dockerfile -t qcloud-panel:test \
#     --build-arg COMMIT=$(git rev-parse HEAD) .
#
# Build context: the repository root.

ARG BUN_IMAGE=oven/bun:1.4.2-slim@sha256:cb3bbbb08e13a4a2ff400f24c7a2a1d5efa83f6ef8544d52d95a519631e2fc61

FROM ${BUN_IMAGE} AS build
WORKDIR /app
COPY package.json bun.lock ./
COPY packages/panel/patches packages/panel/patches
COPY packages/control-api/package.json packages/control-api/
COPY packages/core/package.json packages/core/
COPY packages/maintenance/package.json packages/maintenance/
COPY packages/panel/package.json packages/panel/
COPY packages/sdk/package.json packages/sdk/
COPY packages/store-postgres/package.json packages/store-postgres/
COPY packages/transport-aws/package.json packages/transport-aws/
COPY packages/transport-gcp/package.json packages/transport-gcp/
COPY packages/transport-local/package.json packages/transport-local/
# The build needs the panel's dev dependencies (Vite, TypeScript); none of them reach the image.
RUN bun install --frozen-lockfile --ignore-scripts --filter '@qelay-cloud/panel'
COPY packages/panel packages/panel
WORKDIR /app/packages/panel
# `build` is `tsc --noEmit && vite build`: a type error stops the image. VITE_BASE stays `./`; the
# server points the page at its mount, so one build serves any path.
RUN bun run build \
 && bun build serve/main.ts --target=bun --outfile=/out/server.js \
 && cp -r dist /out/dist

FROM ${BUN_IMAGE} AS runtime
ARG COMMIT=unknown
LABEL org.opencontainers.image.title="qcloud-panel" \
      org.opencontainers.image.description="Qelay Cloud control panel" \
      org.opencontainers.image.revision="${COMMIT}" \
      org.opencontainers.image.licenses="MIT"
WORKDIR /app
ENV NODE_ENV=production \
    QCLOUD_PANEL_HOST=0.0.0.0 \
    QCLOUD_PANEL_PORT=8080 \
    QCLOUD_PANEL_DIST=/app/dist
# One bundled file and the static build: no node_modules, no sources, no shell scripts.
COPY --from=build --chown=root:root /out/server.js ./server.js
COPY --from=build --chown=root:root /out/dist ./dist
USER bun
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD ["bun", "-e", "fetch('http://127.0.0.1:8080/health').then((r)=>process.exit(r.ok?0:1),()=>process.exit(1))"]
ENTRYPOINT ["bun", "/app/server.js"]
