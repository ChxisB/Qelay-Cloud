# syntax=docker/dockerfile:1.7
#
# The ingest: the public listener that stores what a sender posts to `/s/<token>`. It holds no job
# state, publishes to no queue and calls no destination, so it needs the database and nothing else.
#
#   docker build -f packages/ingest/Dockerfile -t qcloud-ingest:test \
#     --build-arg COMMIT=$(git rev-parse HEAD) --build-arg VERSION=1.0.0 .
#   docker buildx build --sbom=true --provenance=mode=max ...      # the SBOM and provenance attestations
#
# Build context: the repository root. Same shape as packages/control-api/Dockerfile: the packages run
# as TypeScript source under Bun, and the build installs the production dependencies of the one
# package from the committed lockfile. The schema is migrated by `qcloud-api migrate`, not here.

# The same pinned base as the other images (see packages/control-api/Dockerfile before moving it).
ARG BUN_IMAGE=oven/bun:1.4.2-slim@sha256:cb3bbbb08e13a4a2ff400f24c7a2a1d5efa83f6ef8544d52d95a519631e2fc61

FROM ${BUN_IMAGE} AS deps
WORKDIR /app
# Manifests first, so the install layer is reused until a dependency changes. A workspace that is
# not on disk is skipped, so only the ingest, what it imports and what the root package depends on
# (transport-local, its manifest only) are copied.
COPY package.json bun.lock ./
COPY packages/panel/patches packages/panel/patches
COPY packages/ingest/package.json packages/ingest/
COPY packages/core/package.json packages/core/
COPY packages/store-postgres/package.json packages/store-postgres/
COPY packages/transport-local/package.json packages/transport-local/
RUN bun install --frozen-lockfile --production --ignore-scripts --filter '@qelay-cloud/ingest'
# Source only: the .dockerignore leaves tests, spikes and the panel's sources out.
COPY packages/core packages/core
COPY packages/store-postgres packages/store-postgres
COPY packages/ingest packages/ingest

FROM ${BUN_IMAGE} AS runtime
ARG COMMIT=unknown
ARG VERSION=0.0.0
LABEL org.opencontainers.image.title="qcloud-ingest" \
      org.opencontainers.image.description="Qelay Cloud inbound request listener" \
      org.opencontainers.image.revision="${COMMIT}" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.licenses="MIT"
WORKDIR /app
ENV NODE_ENV=production \
    QCLOUD_INGEST_HOST=0.0.0.0 \
    QCLOUD_INGEST_PORT=8081 \
    QCLOUD_VERSION=${VERSION} \
    QCLOUD_COMMIT=${COMMIT}
# Owned by root and read-only to the process.
COPY --from=deps --chown=root:root /app ./

# The `bun` user (uid 1000) of the base image: no shell login, no write access to /app.
USER bun
EXPOSE 8081
# `/healthz` answers without a database call, so a database outage does not restart every instance.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["bun", "-e", "fetch('http://127.0.0.1:8081/healthz').then((r)=>process.exit(r.ok?0:1),()=>process.exit(1))"]
ENTRYPOINT ["bun", "/app/packages/ingest/src/bin.ts"]
