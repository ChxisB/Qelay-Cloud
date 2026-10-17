# Task 31: Control API, dashboard, queues, jobs and the job inspector (2026-10-15)

**Done locally. No cloud resource was touched** (no `terraform apply`, no `gcloud` or `aws` command). Everything ran against the local
PostgreSQL 18.6, not the Docker PG 16 of CI.

**Changed files**

- `packages/store-postgres/src/store/` (new): `readModels`, `readQueries`, `operator`, `jobEdits`, `queueControl`, `controlApi`,
  `jobDetails`, `jobFailure`, `facets`, `throughput`; `postgresStore.ts` exposes `readModels`, `control`, `queues`, `metrics`. No
  migration. New plan rows in `test/schema.planned.ts` and `test/schema.planned.operator.ts`.
- `packages/core/src/` (`errors`, `jobs`, `store`): the types the operator edits and read models share.
- `packages/control-api/src/`: `routes/{queues,queueOps,jobs,jobActions,addJob,unsupported,jobsModule,stats}.ts`,
  `jobs/{payload,limits,model,pagination,ring,addSchemas,actionSchemas,context,queueActions,dashboardReader}.ts`, `cache.ts`, `deps.ts`,
  `errors.ts`, `app.ts`, `http/router.ts` (trailing wildcard).
- `packages/control-api/test/`: 14 new or extended files (316 tests in 25 files for the package), `contract/shapes/{panel-bq-types,
  panel-job-validation,jobs-schemas}.ts`, `openapiSpec.ts`.
- `docs/openapi.yaml` (57 operations), `docs/PORTING.md` (3 rows), `docs/compat.md`, `DESIGN.md` (section 6), `packages/control-api/README.md`.
- Task file (Result, status), `CURRENT.md` (row 31, 22 of 42).

**Checked**

- `bun run typecheck && bun run lint && bun run format:check && bun run architecture`: clean (527 files within 300 lines).
- `bun test packages/control-api`: 316 pass, 0 fail. `--grep "queues|jobs|dashboard"`: 118 pass.
- `QCLOUD_REQUIRE_DB=1 bun test` (all): 2,046 pass, 114 skip, 1 fail (the flaky task 30 test, fixed after). `bun run test:model`: 17 pass.

**Measured**

- 500-job list page 270 KB in 37 ms; 500 jobs of 20 KB payloads 410 KB (cut to the list budget); queue page 2 KB.
- Counts, summary, dashboard and queue page on a 100,000-job queue together: 79 ms.

**Decisions**

- `expectedVersion` is optional on the wire until the panel sends one (task 34). Confirmation (`confirm: <queue name>`) is required.
- Closed in v1, 501 `not_supported`: retry of a failed job, `fail`, `discard`, `move-to-wait`, `move-to-delayed`, changing `lifo`.
- Drain, clean and obliterate stop at a 20 s budget and answer `done: false`.
- Counts are index-only aggregates, cached 2 s per instance (`X-Qelay-Cache: bypass`); lists are paged to 500, offset to 100,000, then a
  cursor; a job's timeline is at most 20 entries.
- Worker-protocol routes are not served (workers use the SDK).

**Found and fixed** (failing test first)

- A job with 20 failed attempts had a 23-entry timeline; the panel's inspector accepts 20. Capped.
- `/jobs/:id/result` had no `id`; the inspector requires it.
- `pipeline.edge.test.ts` (task 30) failed about 1 run in 70: a random request id can contain `abc`, which the no-leak check searched for.
- The router could not tell `/jobs/custom/:customId` from `/jobs/:id/logs`; it now has a trailing wildcard and literal-first matching.

**Owed**

- Plan-wide, at the end: the Docker-backed gate (PG 16, PgBouncer, TLS, ElasticMQ), `test:model` with every compose profile, the PG 16
  snapshot and EXPLAIN recheck, and removal of `packages/store-postgres/spike/` (task 40).
- Task 34: the panel's `{ error: string }` reads, `confirm` on drain, clean and obliterate, `expectedVersion`, and the `/capabilities` client.
- Task 37: map environment variables onto `jobs.options`.
- Carried: the cross-queue finished-job custom-id replacement question (task 18); `version` restarts at 0 on that replacement.
