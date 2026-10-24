# 06 — Migration 21: remove the job-event pipeline from every layer

**Status:** done · **Depends on:** 05 · **Touches:** packages/core, store-postgres, maintenance, control-api, panel (types only),
docs, docs/openapi.yaml
**Gate:** migration (approved 2026-10-23)

## Goal
`job.pushed`, `job.started`, `job.completed`, `job.failed`, `job.progress`, the delivery writer and the route loop check are gone.
A route has a source, and nothing else feeds it.

## Steps
1. Migration 21: drop the trigger, `qcloud_enqueue_webhook_deliveries`, `qcloud_webhook_writers`; disable every route that has
   no `source_id` with the reason "its source, a queue's job events, was removed"; make `events` and `queue` of a route unused
   (dropped), and the job columns of a delivery nullable. The old `qcloud_webhook_deliveries` table is not touched.
2. Delete: `store/webhookWriter.ts`, `webhookPlan.ts`, the cursor `webhookDedupe.ts`; `maintenance/webhookWrite.ts`, the writer
   command of `qcloud-tick`; core `WEBHOOK_EVENTS`, `JOURNAL_TO_WEBHOOK`, `SUBJECT_FIELDS`, `deliveryBody`'s job fields,
   `webhookRoute.ts`'s `routeProblem`, `MAX_ROUTE_CHAIN`; Control API `events`/`queue`, `route_cycle`, `route_chain`.
3. `docs/openapi.yaml`: drop `events`, `queue` and the writer text from the webhook paths.
4. Rewrite or remove the tests listed in the survey (`webhook.writer`, `webhook.rules.writer`, `webhook.trigger`,
   `webhook.write`, `webhook.loop`, `cli.send` where it names a writer, `webhooks.gateway`, ...): a test is edited to assert
   the new behaviour or deleted with the code it tested. It is never loosened.
5. The panel's `WEBHOOK_EVENTS`, `jobPayload` and event types are removed with their users (the form itself is task 08).
6. Regenerate `schema.snapshot.txt`; review its diff.

## Acceptance
- `grep -rn "job\.pushed\|job\.started\|job\.completed\|job\.failed\|job\.progress" packages docs` finds only the historical
  notes in DESIGN.md and migration comments.
- A database with routes and deliveries at version 20 migrates to 21; its routes are disabled with the reason and kept.
- A source's request still reaches its destination end to end (the task 04 test, unedited).
- The full gate with Postgres up is green.

## Verify
```bash
QCLOUD_REQUIRE_DB=1 bun run typecheck && bun run lint && bun run format:check && bun run architecture && QCLOUD_REQUIRE_DB=1 bun test
```

## Risks / notes
- The biggest diff of the run. Everything it deletes was proven replaced by tasks 02 to 05 before it starts.

## Result
Done 2026-10-23.

**What changed**
- Migration 21 (`schema/ddl/webhookJobEvents.ts`): drops trigger `qcloud_events_webhook_deliveries`, function
  `qcloud_enqueue_webhook_deliveries()`, table `qcloud_webhook_writers` and index `qcloud_deliveries_event_idx`; disables every
  route with no source with the reason "its source, a queue's job events, was removed" and keeps it; fails unfinished legacy
  deliveries; drops the webhook columns `events`, `queue` and `active_from`; makes a delivery's `queue` and `job_id` nullable.
  The shipped DDL of migrations 8, 13, 14 and 20 is untouched. The schema snapshot was regenerated and reviewed.
- Deleted: `webhookWriter.ts`, `webhookPlan.ts`, `webhookDedupe.ts` and `webhookRouteCheck.ts` (store), the writer command of
  `qcloud-tick`, core `WEBHOOK_EVENTS`, `JOURNAL_TO_WEBHOOK`, `SUBJECT_FIELDS`, `routeProblem`, `MAX_ROUTE_CHAIN`, and the Control
  API errors `route_cycle` and `route_chain_too_long`.
- Control API and `openapi.yaml`: a route has `source: string | null`. `POST /webhooks` requires `source`, and `events` or `queue`
  gives 400. A delivery has `requestId` (nullable) and `routedJobId`, and no `queue` or `jobId`.
- Panel (minimal, the full UI is task 08): the event picker, the queue-event types and the job payload fixtures are gone. The
  form has a plain Source id box. `buildWebhookBody(url, source, secret, route)` needs a source. The events table says "Request"
  where it said "Job". Copy speaks of inbound sources and requests.
- Tests and docs ported or deleted with the code they tested; none loosened. Docs: `DESIGN.md` (D11 and D13 history marked, D14),
  `webhooks.md`, `event-gateway.md`, `operations.md`, `limits.md`, `observability.md`, `reference/configuration.md`,
  `security/threat-model.md`, `known-issues.md`, `concepts.md`, `openapi.yaml` and the generated route docs.

**What ran, and against what** (local PostgreSQL 18.6, Homebrew, as an emulator of the compose service; Docker was not used)
- `bun run typecheck`, `lint` (warnings only), `format:check`, `architecture`: exit 0.
- Full `bun test` with `QCLOUD_REQUIRE_DB=1`: 6013 pass, 252 skip, 1 fail. The one failure is `package metadata > every package is
  MIT ... carries a licence file`: commit 4103cee dropped the upstream copyright line from LICENSE, and whether to keep it is the
  owner's call. It failed before this task too.
- The 252 skips are the opt-in suites that need a service that was not running (Pub/Sub emulator, ElasticMQ, PgBouncer, TLS Postgres).
- `bun run docs:check` (7 documented blocks run), `docs:transports` (no change), `security:routes --write` (no change), the openapi
  tests (37 pass), `bun run --cwd packages/panel build`, the full panel suite (2099 pass, 0 fail; HEAD was 2100 / 0).
- The task 04 tests (`webhook.request.test.ts`, `webhook.request.db.test.ts`): 13 pass, files unedited since 09:47.
- `schema.migrate.jobEvents.test.ts` seeds a version-20 database with routes and deliveries, migrates to 21, and asserts the routes
  are disabled with the reason and kept.

**Not run:** Docker-backed runs, the Pub/Sub, ElasticMQ, PgBouncer and TLS suites, `test:model` (queue semantics are unchanged),
`test:e2e` (needs a browser; task 08 owns the panel), any real cloud (D9).

**Findings on the way**
- Two failures were the scratch database, not the code. It had been started with `synchronous_commit=off`: VACUUM cannot set the
  visibility map for rows whose commit is not yet flushed, so `schema.indexes > workflow counts ... name_state_idx` (an index-only
  plan) could not pass, and it failed on the HEAD export too. And it used trust auth, so the game-day secret-rotation test never saw
  a stale password rejected. Restarted with the compose settings and scram-sha-256: both pass.
- Four `read.plans.*` failures in one full run did not repeat alone or in the second full run (load flake).

**Decisions to carry to the final report**
- Migration 21 is deliberately not rolling-safe: 1.0.0 is unreleased and the owner chose one forward migration (2026-10-23). It
  drops `qcloud_deliveries_event_idx`, which only the removed trigger used.
- The namespace-isolation trigger test and the `webhook.cost` measurement were dropped with the trigger (`limits.md` edited).
- The task 05 create response gives a token, not a URL; the ingest base URL is task 07's.
- Remaining matches for `job.pushed|started|completed|failed|progress` under `packages docs`: `job.progress` and `job.started_at`
  style property and alias accesses (regex dot); the version-8 DDL (`webhooks.ts`, shipped); the legacy fixtures of the migration
  tests that seed pre-21 data (`schema.migrate.destinations/issues/inbound/jobEvents`, `webhook.partitions`, `webhook.routes`);
  and two history notes in DESIGN.md (the D14 row, and the "Deliveries are made in the job's transaction" bullet, marked as removed by D14). `docs/` has none.
