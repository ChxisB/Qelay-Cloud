# Event gateway and a smaller console

Requested by the owner on 2026-10-21, with the Hookdeck docs (https://hookdeck.com/docs) as the reference:
1. "So many sections on the navigation, do we need them all? Clean up everything."
2. "Our webhook system should be more of an event gateway, with the ability to have webhooks."
3. "Workflows and job flows feel like the same thing."
4. "Should there be an 'Event flow': if event A is hit, it then does event B? Not all events want other events."

## Goal
A console with about half the navigation, one place for "things that run in order" (Flows), and one place for "events
going somewhere" (Event gateway), where a webhook is one kind of destination and "when A happens, do B" is a route
that is opted into per event.

## Findings (what is true today)
- **Nav:** 28 items in 6 sections (`navConfig.ts`). 11 `*-classic` routes are linked from nowhere (about 2,000 lines of
  `src/pages/*.tsx`, `pages/jobs/Classic*`, `pages/queue/QueueConfig.tsx`, 5 `classic-*` tests). The Control group repeats the
  parents: Add job, Bulk add, Job inspector (Jobs), Queue control (Queues), DLQ control (Dead letter queue).
- **Flows vs workflows are one idea in the UI and two engines underneath.** A flow is a parent job that waits for its
  children, written once in one transaction (D6, `FlowProducer`, `qcloud_dependencies`). A workflow is durable steps,
  branches, loops, signals, waits and compensation, defined in worker code and run as `wf:step` jobs (DESIGN section 8).
  Every flow can be written as a workflow, not the other way round. The owner is right that the *page* should be one; merging
  the *engines* would rewrite D6 and buy nothing the owner asked for. **Recommendation: one Flows page, two engines.**
- **A webhook is already a Hookdeck connection with a fixed source.** Source = the job event journal; rules = `filter`,
  `shape`, per-webhook rate, retry schedule, auto-pause after 20 failures; destination = one HTTPS URL; events = deliveries
  and attempts, with retry. Missing against Hookdeck: more than one destination kind, an inbound source, delay, dedupe,
  bulk retry, replay, issues.

## Hookdeck concept to Qelay
| Hookdeck | Qelay today | Plan |
|---|---|---|
| Source | job event journal (`qcloud_events`) | the built-in source "Qelay jobs" (one queue); **inbound HTTP sources are D12, a separate plan** |
| Connection (rules[]) | a `qcloud_webhooks` row (`filter`, `shape`, rate, retry) | the row is the connection; add `destination` kind. No rename of the table or `/webhooks` routes |
| Destination: HTTP | the webhook `url` | unchanged |
| Destination: Mock / CLI | none | out |
| Destination: queue / flow | none | **new: "enqueue a job"; this is "event A then B".** "Start a workflow" is that route plus a worker that calls `startWorkflow` (D11: the tick holds no definitions) |
| Rules: filter, transform | `filter`, `shape` (declarative, no code) | keep declarative; no user JavaScript |
| Rules: retry, rate, pause | exists | keep |
| Rules: delay, deduplicate | none | out of the first cut (listed in phase D) |
| Request / Event / Attempt | event journal row / delivery / attempt | same words in the panel |
| Retry, bulk retry, replay | retry one failed delivery | add bulk retry; replay is out |
| Issues | webhook pause + Alerts page | a read-only Issues tab derived from paused and failing routes (task 11); no acknowledge or resolve state; Alerts stays |
| Delivery groups, bookmarks, CLI | none | out |

"Not all events want other events" falls out of the model: an event with no route does nothing. A route that ends in an
internal destination (a job) can itself produce job events, so a chain is routes feeding routes. A loop is refused when a
route is saved: a cycle check and a chain cap of 5 over the source-queue to target-queue edges (D11).

## Scope
- **In:** panel navigation and page merges (A, B); the event gateway on the existing webhook tables, with internal
  destinations and bulk retry (C).
- **Added 2026-10-21 (owner):** a **Home** screen that shows every metric and error (task 13), and an Event gateway page that
  follows Hookdeck's screens (task 11). Inbound HTTP sources are wanted too, as D12 in their own plan.
- **Out:** user JavaScript transforms, delay, dedupe, replay, delivery groups, stored Issues state, Outpost-style tenant
  portals. Merging the flow and workflow engines.

## Touches
- A, B: `packages/panel` only (nav, pages, redirects, tests, README, DESIGN-MAP). No API, no migration, no dependency.
- C: migration 16 (additive), `packages/core`, `store-postgres`, `maintenance`, `control-api`, `docs/openapi.yaml`, panel,
  `docs/webhooks.md`, DESIGN.md section 6.

## Design impact (a gate for C)
A and B fit DESIGN.md. **C does not fit as written:**
- Section 6 says the tick's sender "is operator-scale; fan-out belongs in a separate SDK-run delivery queue". A gateway that
  enqueues jobs from deliveries is still operator-scale (it writes rows in the same database), but it needs to be stated.
- An inbound source (phase D) is a public ingest path at third-party volume: its own service (`infra/`), rate limits, a
  security review. That is a new decision (D11), not a change to a task.
- The webhook routes are what the previous release serves. C only adds fields and routes; nothing is renamed or removed.
So C starts with task 07, a DESIGN.md decision the owner signs off, before any migration.

## Risks
- The working tree has **342 modified files** that are not committed (branch `feat/review-2026-10-19`). A and B land as
  their own diffs only if the owner commits or stashes first; this plan commits nothing.
- A merged page must keep every action of the pages it absorbs. Each fold has an action-parity test (old action, new place).
- Old URLs are bookmarks: every removed path redirects (the `/cron-manager` pattern in `App.tsx`).
- Flow-safety rules in `shared/flowOperationPolicy.ts` (the Purge buttons stay disabled) move with the page, unchanged.
- C adds a new way to create jobs from a delivery: it must go through the existing store `enqueue`, honour queue limits,
  and carry the depth cap, or one route can flood a queue.

## Status

| # | Mini-task | Depends on | Gate | Status |
|---|-----------|-----------|------|--------|
| 01 | Delete the 11 classic pages, redirect their paths | none | none | done |
| 02 | Fold Add job, Bulk add, Job inspector, Queue control, DLQ control into their parents | 01 | none | done |
| 03 | One Health page: Deployment, Diagnostics, Job delivery, Usage as tabs | 01 | none | done |
| 04 | One System page: Server, Database, Backups, MCP, Benchmark, Fleet as tabs | 01 | none | done |
| 05 | New nav (14 items, 5 sections), titles, breadcrumb, palette, capability paths, e2e, docs | 02-04, 06 | none | done |
| 06 | One Flows page for job flows and workflow runs | none | none | done |
| 07 | DESIGN.md decision D11: the event gateway model, and what stays out | none | **owner sign-off** | done (D11 Decided 2026-10-21) |
| 08 | Migration 16 and store: destination and target on a route, the loop check on save | 07 | **migration** | done |
| 09 | Core and maintenance: the `queue` destination (enqueue from a delivery) | 08 | none | done |
| 10 | Control API and `openapi.yaml`: destination fields, bulk retry, all-routes events and stats reads | 09 | **new routes** | done |
| 11 | Panel: Event gateway laid out like Hookdeck (Connections, Events, Metrics, Issues), `/webhooks` redirects | 10, 05 | none | done |
| 12 | Docs: `event-gateway.md`, `webhooks.md`, concepts, README, DESIGN-MAP, completion note | 11, 13 | none | done |
| 13 | Panel: Home (Overview becomes the one screen for every metric and error) | 10, 05 | none | done |

Order: 06, then 01 to 05, 07 to 13 are done. Home (13) can start before 10 with every card but the event gateway's.
Inbound HTTP sources (D12) are a separate plan: `.claude/.planning/inbound-sources/CURRENT.md`.

## Result
Empty until built.
