# Task 35: Panel, Transport and Deployment pages (2026-10-15)

**Done locally. No cloud resource was touched.** The Control API and the panel ran on a local PostgreSQL 18.6 and the
in-process transport, in Chromium and WebKit. The GCP transport's new dead-letter peek and dead-letter age were
unit-tested only: the Pub/Sub emulator and a real project were not used. AWS is task 43. Firefox and the CI `e2e` job
have not run.

**Changed files**

- Core: `packages/core/src/transport.ts` (additive `DeadLetter`, `DeadLetterPeek`, `DeadLetterAge`; the pinned
  `DeliveryTransport` and `TransportStats` are untouched).
- Store: `packages/store-postgres/src/store/deployment.ts` (new: `DOORBELL_HEALTH`, `doorbellHealth`, `schemaVersion`,
  `connections`, `existing`), `src/postgresStore.ts` (reformatted), `test/deployment.test.ts`,
  `test/schema.planned.deployment.ts` (three plan rows). No migration.
- GCP transport: `packages/transport-gcp/src/{deadLetters,options,transport,monitoring,index}.ts` and tests.
- Control API: `src/{opsTypes,config,deps,index,app}.ts`, `src/ops/{context,doorbells,transportView,tick,warnings,
  deploymentView,deadLetters}.ts`, `src/routes/ops.ts` (`GET /transport`, `GET /transport/dead-letters`,
  `GET /deployment`), `docs/openapi.yaml`; tests `ops.transport`, `ops.deadLetters`, `ops.deployment`,
  `ops.deployment.access` and the `transportHarness` and `deploymentHarness` helpers.
- Panel: `src/lib/ops/{types,health}.ts`, `src/pages/control/{Transport,Deployment}.tsx`,
  `transport/{QueueDoorbellTable,DeadLetterPanel}.tsx`, `deployment/{WarningList,Facts}.tsx`,
  `overview/StatusStrip.tsx` (mounted in `OverviewPro.tsx`), `src/lib/demo/ops.ts`, and the changed `App.tsx`,
  `navConfig.ts`, `pageTitle.ts`, `lib/api.ts`, `lib/demo/api.ts`. Tests: `ops.helpers`, `ops-types`, `ops-health`,
  `ops-api`, `ops-nav`, `ops-deployment-page`, `ops-transport-page`, `ops-status-strip`; `demo-api-complete`,
  `app-routes-complete` and `nav-shell` updated.
- e2e: `packages/panel/e2e/deployment.e2e.ts` (new), `runtime.ts` (a real `TickLoop`, `POST /tick/stop` and
  `/tick/start`, thresholds and `readiness.tick` over `store.maintenance.tickStatus()`), `config.ts`, `fixtures.ts`.
- Docs: `docs/PORTING.md` ("Transport and Deployment pages (task 35)"), `packages/panel/README.md`, the task file
  (Result, status), `CURRENT.md` (row 35, 26 of 42).

**Checked**

- `bun run typecheck && bun run lint && bun run format:check && bun run architecture`: exit 0 (lint reports the carried
  panel warnings, none from this task's files).
- `QCLOUD_REQUIRE_DB=1 bun test` on PG 18.6: 3,572 pass, 114 skip (Pub/Sub emulator, ElasticMQ, PgBouncer, TLS), 0 fail.
- `bun test packages/panel`: 1,284 pass, 0 fail (211 files).
- `bun run test:e2e --project=chromium`: 21 passed (18 before, 3 new). WebKit: the 3 new specs passed.
- `bun run test:model` not run: no queue semantics changed.

**Measured**

- The e2e spec takes about 13 s on Chromium and WebKit: the tick stops, the strip is amber once the tick is 4 s old
  and red at 9 s, and the panel polls every 3 s.
- 1,208 project TypeScript files satisfy the 300-line limit.

**Decisions**

- Additive, optional `DeadLetterPeek` and `DeadLetterAge` on the transport rather than a change to the pinned
  `DeliveryTransport` and `TransportStats`.
- "Not rung" is the tick-behind signal; "re-ring due" is normal in a backlog and is only said plainly.
- Counts are capped at 1,000 and read only for queues with pending jobs; idle queues are synthesized as zero.
- The local transport has no doorbell dead-letter queue and says so; its failed jobs are the DLQ page's.
- `/transport/dead-letters` is operator-only, a peek of at most 25, and never a redrive (task 71's runbook).
- `/transport` is 501 without jobs routes; `/deployment` degrades to `unknown` and a warning, and holds no secret.
- The strip's colour is health (tick, database, doorbells, transport), not configuration; the development token is a
  warning on the Deployment page only.
- Tick thresholds are configurable (amber 60 s, red 5 min by default) through `deployment` options.
- The panel does not send `x-qelay-cache: bypass` (it would force a CORS preflight).
- `connections` counts every session to the database.

**Found and fixed**

- Two Control API test files went over the 300-line cap while the cases were added: split with shared harnesses (the
  first version took the fixture by value before `beforeAll` ran; now a getter).
- A formatter built for job runtimes printed "125m 3s" where the page needed "up to 5m behind": the panel has its own
  `span`.
- The dead-letter table keyed rows by array index: keyed by job id and occurrence.
- `nav-shell.test.tsx` went to 302 lines with the new nav case: moved to `ops-nav.test.ts`.

**Owed**

- Pub/Sub dead-letter peek and the Monitoring dead-letter oldest-age metric against the emulator and a real project
  (task 36 with D9, and the Pub/Sub suites at the end).
- `QCLOUD_COMMIT`, fleet and threshold environment mapping: task 37's entrypoint.
- Contract shapes for the three endpoints in `packages/control-api/test/contract/shapes` (they are in `openapi.yaml`
  and the route tests).
- PG 16 re-run of the `DOORBELL_HEALTH` plan rows with the other snapshots at the end.
- Firefox e2e and the CI `e2e` job's first run.
