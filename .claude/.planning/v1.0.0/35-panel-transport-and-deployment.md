# 35 — Panel: Transport and Deployment pages

**Status:** done locally · **Depends on:** 34, 20 · **Phase:** 2

## Goal

Add the two pages that only exist because this runs on managed cloud services: a **Transport** page (is the doorbell path healthy?) and a **Deployment** page (is the system healthy and correctly configured?).

## Scope

In: Control API endpoints `GET /transport` and `GET /deployment`, the two panel pages, and "last tick" and "overdue doorbells" indicators on the Dashboard.
Out: alert routing (task 71), cost reporting.

## Steps

1. **`GET /transport`:** name (Pub/Sub or SQS), per-queue doorbell depth, oldest-undelivered age, dead-letter depth and its oldest age, each with a `freshness` timestamp (cloud metrics lag; show it), plus the transport's capabilities (`maxDeliverDelayMs`, ordering).
2. **Doorbell health view:** per queue, join the transport's numbers with the store's: `claimable jobs` vs `doorbell depth` vs `jobs with rung_at null or overdue`. A large "claimable but not rung" count means the tick is behind; a large DLQ depth means poison doorbells. State the meaning in the UI.
3. **Doorbell DLQ panel:** list recent poison doorbells (queue, job ID, delivery count) read-only, with a link to the job in the inspector when it exists. Redrive from the cloud DLQ is a manual runbook step in v1.0.0 (task 71), not a button.
4. **`GET /deployment`:** version and commit, schema version versus code's expected version, database reachability and latency, connection usage versus the budget (task 05), **last successful tick** and its age with a clear stale threshold, worker count, and configuration warnings (for example "dev token enabled", "no tick in the last 5 minutes", "schema ahead of code").
5. **Dashboard indicators:** a status strip for tick age and overdue doorbells; clicking goes to the Deployment page.
6. **Empty and error states:** metrics unavailable (permissions or API error) shows "unknown", never zero.
7. **Tests:** API contract tests per transport; component tests for each warning state; an e2e check that stopping the tick turns the indicator amber, then red.

## Acceptance

- Transport and Deployment pages render for both the local transport and the GCP transport (AWS added in task 43).
- Stale metrics are labelled with their age; an unavailable metric is "unknown", not 0.
- Stopping the tick in the local stack makes the Dashboard indicator go amber then red within the configured thresholds.
- No secrets (connection strings, tokens) are present in any `/deployment` response (test).

## Verify

```bash
bun run typecheck && bun run lint && bun run format:check && bun run architecture
bun test packages/control-api packages/panel
bun run test:e2e
```

## Risks / notes

- Cloud queue metrics are delayed by minutes on both clouds. The page must not imply real-time precision it does not have.
- Showing "claimable but not rung" depends on `rung_at`; this is the visible payoff of that column, so get the wording right.
- Keep `/deployment` read-only. Configuration changes happen in infrastructure code.

## Result

**Done locally (2026-10-15). No cloud resource was touched.** The Control API and the panel ran on a local PostgreSQL
18.6 with the in-process transport; the GCP transport's new dead-letter peek and the Cloud Monitoring dead-letter age
were written and unit-tested but never run against the Pub/Sub emulator or a real project. AWS is task 43.

**What exists now**

1. **`GET /transport`** (any role). Transport name, `maxDeliverDelayMs`, ordering, whether the broker has a dead-letter
   queue of doorbells, and per queue: doorbell depth, oldest undelivered age, dead-letter depth and oldest age, each
   with `freshness {observedAt, ageMs, maxStalenessMs, source}`, next to the store's own numbers for the same queue
   (`claimable`, `notRung`, `reRingDue`, `oldestNotRungAgeMs`, `paused`, `capped`). Queues with pending jobs first,
   capped at `deployment.maxQueues` with `truncated`. A broker that throws gives `null` for that queue and a log line
   that names the error type only; a number that was not read is `null`, never `0`. 501 when the deployment serves no
   jobs routes.
2. **`GET /transport/dead-letters?queue=&limit=`** (operator only: it reads from the broker and names job ids). A
   sample, read without consuming, with `available:false` and a `reason` (`not_supported`, `unreachable`) when it
   cannot say. No endpoint redrives; redrive stays a runbook step (task 71).
3. **`GET /deployment`** (any role). Version, commit, production flag, whether the dev token is on (never its value),
   schema `current` against `expected`, database state and latency, transport state, connections in use against
   `max_connections` and against `budget()` of task 05 when a fleet is declared, tick state and age against the two
   thresholds (amber 60 s, red 5 min, configurable), worker counts, overdue doorbells, and `warnings[]` with stable
   codes (`database_unreachable`, `transport_unreachable`, `tick_never_ran`, `tick_stale`, `tick_late`,
   `tick_unknown`, `schema_ahead`, `schema_behind`, `connections_exhausted`, `connections_high`,
   `connection_budget_exceeded`, `doorbells_overdue`, `dev_token_enabled`). A failed probe degrades to `unknown` and a
   warning; the page still answers.
4. **Store:** `store.deployment.{doorbellHealth, schemaVersion, connections, existing}` over `qcloud_jobs`, with counts
   capped at 1,000 and read only for queues that have pending jobs (an idle queue is synthesized as zero).
   `DOORBELL_HEALTH` has three plan rows in `test/schema.planned.deployment.ts` (picked up by `schema.indexes.test.ts`).
   No migration.
5. **GCP transport:** `PubSubTransport` implements the new additive, optional `DeadLetterPeek` (`peekDeadLetters`) and
   reports dead-letter depth and oldest age through Cloud Monitoring, with the metric lag in `maxStalenessMs`.
6. **Panel:** Transport and Deployment pages (Monitoring in the sidebar), a status strip on the Dashboard (tick age and
   jobs without a doorbell; green, amber, red or "unknown"; links to `/deployment`), demo-mode answers, and empty and
   error states that say "unknown" and never zero.

**Acceptance**

- Pages render for the local transport (unit and e2e) and the GCP transport (Control API tests with a stub of its
  shape and `transport-gcp` unit tests). **Not run against the emulator or real Pub/Sub.**
- Stale metrics carry their age ("45s ago, up to 5m behind · cloud-monitoring"); unavailable ones read "unknown".
- Stopping the tick in the local stack: `e2e/deployment.e2e.ts` runs a real `TickLoop` (1 s) with late 4 s and stale
  9 s, stops it through the runtime, and asserts the strip goes amber, then red, links to the Deployment page where
  `tick_stale` is shown, and is green again after the tick resumes. Chromium and WebKit pass.
- No secrets in any `/deployment` response: `ops.deployment.access.test.ts` puts a connection string with a password in
  `QCLOUD_DATABASE_URL`, declares a fleet and a commit, and asserts that no string in the body contains the token, the
  password, the host or the user, and that no key is named like a secret. A probe that throws with a connection string
  in its message gives a body without it (`ops.deployment.test.ts`).

**Verify**

| Command | Result |
| --- | --- |
| `bun run typecheck` | exit 0 |
| `bun run lint` | exit 0 (the carried panel warnings; none from the files of this task) |
| `bun run format:check` | clean (1,224 files) |
| `bun run architecture` | 1,208 files within the 300-line limit |
| `QCLOUD_REQUIRE_DB=1 bun test` (PG 18.6, no Docker) | 3,572 pass, 114 skip (Pub/Sub, ElasticMQ, PgBouncer, TLS), 0 fail |
| `bun test packages/panel` | 1,284 pass (211 files) |
| `bun run test:e2e --project=chromium` | 21 passed (18 earlier + 3 new) |
| `bun run test:e2e --project=webkit e2e/deployment.e2e.ts` | 3 passed (the full WebKit run was not repeated) |
| `bun run test:model` | not run: no queue semantics changed |

**Decisions**

- `DeadLetterPeek` and `DeadLetterAge` are additive and optional, so the pinned `DeliveryTransport` and
  `TransportStats` are untouched and a transport without a dead-letter queue says so.
- "Not rung" and "re-ring due" are different. Re-ring due is normal in a backlog (more jobs than workers); the age of
  the oldest job that was never rung is the tick-behind signal, so that is what turns the strip amber.
- The strip's colour is about health (tick, database, doorbells, transport), not configuration: the development token
  is a warning on the Deployment page and does not colour it.
- The local transport has no doorbell dead-letter queue (`DeclaredTransport.doorbellDeadLetter`); its "dead letters"
  are failed jobs, which are the DLQ page's.
- `connections` counts every session to the database, not only this deployment's.
- The panel does not send `x-qelay-cache: bypass` (it would force a CORS preflight); the server cache is 2 s.
- The panel has its own duration formatter (`span`): `formatDuration` is built for job runtimes and prints "125m 3s".

**Found and fixed**

- A dead-letter row key built from an index tripped a lint rule and would have re-keyed rows on every sample: keyed by
  job id and occurrence.
- Two Control API test files went over the 300-line cap while adding the cases; split with shared harness helpers.

**Owed**

- Pub/Sub dead-letter peek and the Monitoring dead-letter oldest-age metric against the emulator and a real project.
- `deployment` options from the environment (`QCLOUD_COMMIT`, fleet, thresholds) belong to task 37's entrypoint; today
  they are Control API options only.
- The Dashboard strip is unit- and e2e-tested locally only; Firefox and the CI `e2e` job have not run.
- Contract shapes for the three new endpoints are in `openapi.yaml` and the route tests, not in
  `test/contract/shapes`.
