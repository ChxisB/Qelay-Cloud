# Task 30: Control API core, auth, capabilities, health (2026-10-15)

**Done locally. No cloud resource was touched** (no `terraform apply`, no `gcloud` or `aws` command). The readiness probe ran against the
local PostgreSQL 18.6, not the Docker PG 16 of CI.

**Changed files**

- `packages/control-api/` (new): `src/` (21 files: `app`, `config`, `env`, `server`, `errors`, `deps`, `readiness`, `types`, `index`,
  `auth/{oidc,principal,index}`, `http/{router,body,cors,log,rateLimit}`, `routes/{health,capabilities,stats}`), `test/` (13 files, 178
  tests, plus `test/contract/shapes/` with the panel's types), `README.md`, `package.json`, `tsconfig.json`.
- `docs/openapi.yaml` (new, hand-written, the six core paths), `docs/PORTING.md` (a note and two rows for the panel files copied into
  the contract tests), `DESIGN.md` (section 6, "As built"), `tsconfig.tooling.json` (the package's tests), `bun.lock` (jose 6.2.12,
  zod 4.6.7).
- Task file (Result, status), `CURRENT.md` (row 30, 21 of 42).

**Checked**

- `bun run typecheck && bun run lint && bun run format:check && bun run architecture`: clean (489 files within 300 lines).
- `bun test packages/control-api`: 178 pass, 0 fail.
- `QCLOUD_REQUIRE_DB=1 QCLOUD_REQUIRE_PUBSUB=1 bun test`: 1,932 pass, 54 skip (the Docker-backed suites), 1 todo, 0 fail, 153 files.
  `test:model` was not run: no core queue semantics changed.

**Decisions**

- JWT verification is `jose` (`createRemoteJWKSet`, `jwtVerify`), not hand-rolled. The tick's Cloud Scheduler check keeps its own RS256
  verifier; moving it is a clean-up without a deadline.
- Authentication runs before the 404/405 decision, so an unauthenticated caller cannot learn which paths exist.
- `/health` is the only unauthenticated route. `/healthz` (the panel's other probe) is not served; `/ready` is an authenticated alias.
- Production mode is one-way: `NODE_ENV=production` wins over `production: false`, and the development token is refused in it.
- The rate limit is a per-instance token bucket on write routes only.

**Found and fixed**

- A wildcard-subdomain CORS origin (`https://*.example.com`) parsed as a URL and would never have matched; it is now refused at startup.
- The panel's connection test needs `status` and an integer `uptime` in `/health`; the first version had neither.

**For task 34 (panel adaptation)**

1. The panel reads `{ error: string }`; the service sends `{ error: { code, message, details? } }`.
2. Switch the `/healthz` probe to `/health`.
3. The panel types `storage.diskFull` of a not-ready body as `true`; the service sends `false`.
4. Add a `/capabilities` client.

**Owed**

- Nothing for this task. Plan-wide, at the end: the Docker-backed gate (PG 16, PgBouncer, TLS, ElasticMQ), the PG 16 snapshot and
  EXPLAIN recheck, `test:model` with every compose profile, and the removal of `packages/store-postgres/spike/` (task 40).
- Task 40 replaces the literal SQS declaration in `capabilities.test.ts` with the real transport's `capabilities`.
