# syntax=docker/dockerfile:1.7
#
# The Control API and the tick CLI, one image: `serve` (default) and `migrate` are `qcloud-api`'s
# commands; the tick runs from the same image with a command override (see docs/runbooks/deploy-gcp.md).
#
#   docker build -f packages/control-api/Dockerfile -t qcloud-api:test \
#     --build-arg COMMIT=$(git rev-parse HEAD) --build-arg VERSION=1.0.0 .
#   docker buildx build --sbom=true --provenance=mode=max ...      # the SBOM and provenance attestations
#
# Build context: the repository root. The packages run as TypeScript source under Bun, so there is
# no compile step; what the build does is install the production dependencies of two packages from
# the committed lockfile and leave the tests, the panel and every dev dependency out.

# Pinned by digest (the multi-arch index of oven/bun:1.4.2-slim, which is `.bun-version`). Move it
# deliberately: look the new digest up, change both this line and `.bun-version`, rebuild.
ARG BUN_IMAGE=oven/bun:1.4.2-slim@sha256:cb3bbbb08e13a4a2ff400f24c7a2a1d5efa83f6ef8544d52d95a519631e2fc61

FROM ${BUN_IMAGE} AS deps
WORKDIR /app
# Manifests first, so the install layer is reused until a dependency changes. Every workspace's
# manifest is needed: the frozen lockfile is checked against all of them.
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
COPY packages/transports/package.json packages/transports/
# `--filter` links each package's dependencies from `node_modules/.bun`, so the sources go in this
# stage too and the runtime stage takes the tree whole.
RUN bun install --frozen-lockfile --production --ignore-scripts \
    --filter '@qelay-cloud/control-api' --filter '@qelay-cloud/maintenance'
# Source only: the .dockerignore leaves tests, spikes and the panel's sources out.
COPY packages/core packages/core
COPY packages/store-postgres packages/store-postgres
COPY packages/sdk packages/sdk
COPY packages/transport-aws packages/transport-aws
COPY packages/transport-gcp packages/transport-gcp
COPY packages/transport-local packages/transport-local
COPY packages/transports packages/transports
COPY packages/control-api packages/control-api
COPY packages/maintenance packages/maintenance
# Not part of this image: its manifest was needed for the lockfile check only.
RUN rm -rf packages/panel

FROM ${BUN_IMAGE} AS runtime
ARG COMMIT=unknown
ARG VERSION=0.0.0
LABEL org.opencontainers.image.title="qcloud-api" \
      org.opencontainers.image.description="Qelay Cloud Control API and tick" \
      org.opencontainers.image.revision="${COMMIT}" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.licenses="MIT"
WORKDIR /app
ENV NODE_ENV=production \
    QCLOUD_API_HOST=0.0.0.0 \
    QCLOUD_API_PORT=8080 \
    QCLOUD_VERSION=${VERSION} \
    QCLOUD_COMMIT=${COMMIT}
# Owned by root and read-only to the process.
COPY --from=deps --chown=root:root /app ./

# The `bun` user (uid 1000) of the base image: no shell login, no write access to /app.
USER bun
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["bun", "-e", "fetch('http://127.0.0.1:8080/health').then((r)=>process.exit(r.ok?0:1),()=>process.exit(1))"]
ENTRYPOINT ["bun", "/app/packages/control-api/src/bin.ts"]
CMD ["serve"]
