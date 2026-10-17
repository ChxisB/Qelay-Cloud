# 37 — Phase 2 gate: panel on GCP

**Status:** done locally (no GCP run, needs D9; container scan not run; your sign-off, step 7, not obtained) · **Depends on:** 35, 36 · **Phase:** 2

## Goal

Prove that an operator can run the whole must-have feature set from the panel against the GCP deployment: queues, jobs, the inspector, DLQ, delayed jobs and cron, workers and live events. Close the phase with evidence and the user's sign-off.

## Scope

In: a scripted operator walkthrough, a security pass on the control plane, a performance check of the panel's heaviest pages, the contract-suite re-run, a limits update.
Out: flows and workflows (Phase 4), AWS (Phase 3).

## Steps

1. **Operator walkthrough (e2e, scripted and then manual):** sign in as `viewer` (read-only works, mutations are absent and rejected); sign in as `operator`; add jobs including a delayed job and a failing job; watch live events; pause and resume a queue; see the failed job in the DLQ; inspect its error and attempts; purge with confirmation; create, edit and delete a cron and watch it fire; view workers; open Transport and Deployment and read the tick age.
2. **Failure drills** against the deployed (or local) stack: stop the worker (jobs wait, the panel shows the backlog and no workers); break the transport credentials (the Transport page shows unknown/unhealthy, enqueues still succeed, the tick recovers after repair); stop the tick (the indicator turns red, then recovers).
3. **Security pass:** check the Control API for authentication bypass (every route needs a token except health), role enforcement, CORS, request size caps, SSE connection caps, audit coverage for every mutation, no secrets in responses or logs, dependency audit (`bun audit` or equivalent), container scan. Record findings and fix or file each one.
4. **Performance check:** a queue with 100k jobs, 50 queues; load Dashboard, Queue Control and the job list; record response times and payload sizes against the targets set in task 31 (list pages under 500 ms p95 locally).
5. **Re-run** the Phase 1 gate scenarios and the deep model run to confirm nothing regressed.
6. Update `docs/limits.md` and DESIGN.md status.
7. **User review:** demonstrate or hand over the walkthrough results; get explicit approval before Phase 3 and the later phases begin.

## Acceptance

- The scripted walkthrough passes end to end, and the failure drills behave as specified.
- Security findings are fixed or tracked with an owner and a reason; none is high severity and open.
- Performance targets are met or the gap is recorded with a plan.
- Phase 1 scenarios and the deep model run are still green.
- The user has signed off.

## Verify

```bash
bun run typecheck && bun run lint && bun run format:check && bun run architecture && bun test
bun run test:model
bun run test:e2e
bun run test:scenarios
```

## Risks / notes

- If the panel's heaviest page is slow because of the counts query, the fix belongs in the store (task 15 follow-up), not in a panel-side workaround.
- A security pass done by the author is a weaker check than an independent review. Say so in the Result and let the user decide whether to get one before an external release (task 72).

## Result

**Done on the local stack. Not run on GCP, no image was built or scanned, and the user's sign-off (step 7, the last
Acceptance line) was not obtained**: it cannot be obtained inside this session, and it is the line that opens Phase 3, so it
is yours to give. The other four Acceptance lines are true on this machine (PostgreSQL 18.6, in-memory transport, the real
tick and worker, Chromium and WebKit).

**1. Operator walkthrough** (`packages/panel/e2e/walkthrough.e2e.ts`, `walkthrough.drills.e2e.ts`, `walkthroughKit.ts`;
`runtime.ts` gained `POST /worker/start` and `/worker/stop` over `workerControl.ts`, the SDK's own `Worker`). One test
per role, against the real panel and API:

- *Operator:* adds a job through the form and the worker completes it; adds a delayed job (state `delayed`, then
  `completed`); sees a job go by on the live Activity Logs; pauses the queue (a new job stays `waiting`), resumes it
  (the job runs); adds a failing job with 2 attempts and sees it in the DLQ as `max_attempts_exceeded` with its reason;
  inspects its error and both attempts; creates a cron in the form and watches its `executions` rise and its jobs appear;
  views the Workers page; opens Transport (the queue is listed) and Deployment (tick `ok`, last success under 10 s old).
- *Viewer:* reads every page, finds the mutations absent in the panel, and the server answers 403 to each attempt.
- *Drills:* a stopped worker leaves its jobs `waiting`, the panel shows the backlog and no worker, and the worker's
  return completes them; stopping the tick turns the Dashboard strip amber then red and starting it clears it
  (`deployment.e2e.ts`); breaking the transport credentials (below).
- *Two steps ran at the API, because the panel does not offer them*: purging a DLQ (the panel's Purge and Purge All are
  disabled by its upstream flow-safety rule although the API supports them with `confirm` = the queue name: refused
  without it and with a wrong one, done with it) and editing a cron (the form refuses an existing name, so an edit is
  an upsert, `PUT /crons/:name`). This is a decision owed to you, below.
- The manual half of step 1 ("scripted and then manual") was not done: nobody drove the panel by hand.

**2. Failure drills.** Worker and tick: above. Transport: `packages/control-api/test/drill.transport.test.ts` takes the
broker away (ring and stats throw): enqueues answer 200 and the jobs are `waiting`; the Transport page answers 200 with
doorbell depth unknown, freshness `unavailable`, `notRung: 3`, and nothing of the broker's error text; the tick reports
`unreachable: 3, rung: 0`; after the repair the next pass rings all three and the page reads healthy. This is the
Control API integration test, not a browser test; the page's rendering of `unknown` was proved in task 35.

**3. Security pass.** [docs/security/phase2-pass.md](../../../docs/security/phase2-pass.md): a sweep over every documented
operation (`security.pass.test.ts`, 7 tests) plus the narrower suites; one finding fixed (two critical `tinypool`
advisories through the dev-only formatter: `overrides` entry and lockfile, `bun audit` now clean). **Container scan not
run** (no image exists; finding S7, to close before task 73). **The pass was done by the author of the code, which is a
weaker check than an independent review; task 72 is where you decide whether to get one before anything external.**
No high or critical finding is open.

**4. Performance** (`scripts/perf-control-api.ts`, results in [docs/limits.md](../../../docs/limits.md) section 10):
149,000 jobs over 50 queues, 16 reads: **every p95 under 40 ms serial and under 80 ms with 8 at once**, against the
500 ms target; the largest payload is 264 KB (500 jobs). One run, PostgreSQL 18.6, loopback database: the PG 16 run and a
managed database are owed, and the panel's own render time was not measured.

**5. Re-run.** Gate with the database up and `QCLOUD_REQUIRE_DB=1`: `bun test` **3,658 pass, 114 skip, 0 fail** (the
skips are the Pub/Sub emulator, ElasticMQ, PgBouncer and TLS suites); `bun run test:scenarios` 24 pass, 12 skip (the
Pub/Sub emulator stack); `bun run test:model` green, and deeper: 300 runs of 120 commands on the fake, the Postgres
store and the Postgres store with workers, all 17 tests each; `bun run test:e2e --project=chromium` **24 passed**;
the walkthrough on WebKit 3 passed; Firefox would not launch in the build sandbox (a browser launch timeout, not a test
failure), so the walkthrough has not run there.

**6. Docs.** `docs/limits.md` (sections 8 and 10), `DESIGN.md` (status and the phase table),
`docs/security/phase2-pass.md`.

**What the gate found in the product:** nothing that needed a design change. Nothing was silently deviated from.

**Owed:** your sign-off (and the same for task 22); the manual walkthrough; the container scan and SBOM; Firefox; the PG 16
re-run of the perf script and of the snapshots; a deployed-mode smoke run and a GCP run (D9); an independent security
review (task 72); the panel gaps below.

**Decisions for you**

- The panel's **DLQ Purge, Purge All and Queue Control Drain/Clean** are disabled by the upstream flow-safety rule
  (`FLOW_DELETION_UNAVAILABLE`) while the API supports them behind a typed confirmation. Enabling them is a panel change;
  keeping them off means purging is an API call. Your call.
- The panel's **cron form has no edit**: it refuses an existing name. An edit is `PUT /crons/:name` at the API.
