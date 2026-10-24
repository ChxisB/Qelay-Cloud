# Inbound sources, and a gateway that carries what it is sent (D12, D14)

Requested by the owner on 2026-10-21 ("our sources and add inbound HTTP sources too") and reshaped on 2026-10-23:
"the event gateway queue should just process what has been sent to it and send it to the destination", and "we don't need
job.pushed, job.started, job.completed, job.failed, job.progress". On 2026-10-23 the owner approved D12 as written, removed
the job events entirely, and approved the five gates below. Follows the event-gateway plan (`../event-gateway/`).

## Goal
Whatever is posted to a Qelay source URL (`{ "id": 500, "name": "chris" }`) is stored, optionally filtered, de-duplicated,
delayed and reshaped by the route, and delivered to the route's destination. With no `shape` the destination gets the body
**unchanged**, with its content type. The fixed job events and their "Events to send" buttons are gone.

## Scope
- **In:**
  - A source: name, URL token, verification (none, HMAC, basic, API key), enable and disable, secret rotation.
  - A request log, with rejected requests stored with a cause.
  - Routes whose only source is an inbound source.
  - A separate `packages/ingest` process on `Bun.serve`.
  - Sender, Control API and `openapi.yaml`, and the panel (Sources and Requests tabs, a connection form without events).
  - Replay of a request to its own routes.
  - Removal of the job-event pipeline: trigger, writer, `events` and `queue` of a route, `job.*`, route cycles.
  - Ingest packaging (Dockerfile, chart entry, Terraform plan only), docs and a runbook.
- **Out:**
  - JavaScript transforms, delivery groups, a CLI or mock destination, replay to another source.
  - Per-tenant portals, a Stripe preset (a generic HMAC covers it), a configurable answer (the ingest answers 200 and `{ "id" }`).
  - Parsing form-encoded bodies (a non-JSON body passes through whole and is not addressable by a filter or shape).
  - Any real-cloud run (D9).

## Design impact (DESIGN.md)
- **D12** moves Proposed to Decided (as written, approved 2026-10-23).
- **D14** is new: *the gateway's only source is an inbound request*. Task 01 records it and revises D11 and D13 where they name
  job events.
- This removes what 1.0.0 (unreleased, no tag) had in D11 and D13. The CLAUDE.md two-release rule protects a shipped
  release; none exists, so the removal is one forward migration. The owner chose this on 2026-10-23.

### D14 in short
- A request is **one event per enabled route** of its source, made in the accept transaction. There is no journal cursor, no
  writer to switch on, and nothing for the tick to scan. The ingest never calls a destination; the tick's sender delivers.
- The **event document** a filter, shape or dedupe sees is `{ method, headers, query, body }`, addressed by a dotted path
  (`body.id`, `headers.x-github-event`, `query.page`). `body` is present when the request was JSON.
- **Pipeline** per route at accept time: pause mode, filter, dedupe, shape, delay, then the sender's rate, retry and auto-pause
  as before. Dedupe is one atomic upsert per key (`INSERT ... ON CONFLICT DO UPDATE ... WHERE until <= now`), because several
  ingest processes run at once and the single writer that made the old cursor version exact is gone.
- **No shape:** the destination gets the request body byte for byte with the request's content type. **A shape** rewrites it
  to JSON. `body` NULL on a delivery means "the request's own body"; an empty string stays "the shape was too large".
- **Headers are stored redacted:** `authorization`, `cookie`, `proxy-authorization`, `set-cookie` and the source's own
  verification header are kept as `[redacted]`. At most 64 headers of 2 KB each.
- **No route can loop**, because a queue route adds a job and a job makes no event. The loop check, `route_cycle`,
  `route_chain` and `MAX_ROUTE_CHAIN` are deleted.
- **Routes from before D14** (they listened to a queue) are kept by migration 21, disabled with the reason "its source, a queue's
  job events, was removed". The operator picks a source and enables them. Nothing is deleted.

## Design (panel)
Not needed, reuses the Destinations page (Sources list and form) and the Events table (Requests tab) of the Event gateway, and
the connection form. No new colour, font or route outside the gateway. The deliberate visible change is that "Events to send"
and the queue picker leave the form, and a Source picker joins it.

## Touches
Migrations 20 (sources, requests, `source_id`, `request_id`) and 21 (remove the job-event pipeline), `packages/core`,
`store-postgres`, a new `packages/ingest`, `maintenance`, `control-api`, `docs/openapi.yaml`, `packages/panel`,
`packages/ingest/Dockerfile`, `charts/qelay`, `infra/gcp` and `infra/aws` (plan only), `docs/`, `scripts/` (a load check),
`DESIGN.md`.

## Human gates (CLAUDE.md), approved by the owner on 2026-10-23
1. D12 sign-off and D14: task 01.
2. Migrations 20 and 21: tasks 03 and 06.
3. New Control API routes and openapi: task 05.
4. A new package and a public listener, `Bun.serve`, no new dependency: task 07.
5. `infra/`, `terraform plan` only: task 09.

Still the owner's: `terraform apply` or `destroy`, any `gcloud` or `aws` write, push, publish, a version bump, and a task that
fails its Acceptance twice. Security review (task 10) is a self-review by the `security-review` skill and says so.

## Order, and why
Additive first, removal late. Tasks 02 to 05 add the request path beside the old one, each with a green gate. Task 06 deletes
the old path, so it is a deletion with the new path already proven. Tasks 07 to 11 finish the ingest, the panel, packaging, the
review and the docs.

## Risks
- A public endpoint is the largest new attack surface in the repo: flooding, oversized and slow bodies, spoofed senders, header
  injection into the stored request, and a stored body replayed to a destination (SSRF is the sender's existing check, which
  must run on the route's destination, never on anything the request carries).
- The connection budget (`budget()`): the ingest at volume must use few short transactions, or it starves workers.
- Task 06 deletes a lot at once (about 60 files touched). It runs after the new path is green so that a failure there is a
  deletion mistake and nothing else.
- Dedupe stops being exact by construction and becomes exact by an atomic upsert; task 03 carries a concurrency test.
- Docker-backed runs, Firefox, the container scan and the real clouds are not available or not allowed here; the hand-off lists
  them as not run.

## Status

| # | Mini-task | Depends on | Gate | Status |
|---|-----------|-----------|------|--------|
| 01 | Record D12 Decided and D14 in DESIGN.md | none | approved | done |
| 02 | Core: filter, shape and dedupe work on a request document | 01 | none | done |
| 03 | Migration 20 and store: sources, requests, accept with fan-out | 02 | approved | done |
| 04 | Sender: deliver a request's event, body unchanged by default | 03 | none | done |
| 05 | Control API and openapi: sources, requests, replay, a route's source | 03, 04 | approved | done |
| 06 | Migration 21: remove the job-event pipeline from every layer | 05 | approved | done |
| 07 | `packages/ingest`: the public request path | 03 | approved | done |
| 08 | Panel: Sources and Requests tabs, a connection form without events | 05, 06 | none | done |
| 09 | Packaging and `infra/`: Dockerfile, chart, Terraform plan | 07 | approved | done |
| 10 | Security review and load check of the ingest path | 07, 04 | none | done |
| 11 | Docs, runbook, full gate, completion note | 08, 09, 10 | none | done |

Cloud-audit task 05 (`../cloud-audit/`) is blocked on a D9 real-cloud go-ahead and is not part of this run.
Real-cloud verification (a deployed ingest, a real provider posting to it) is not a task: it needs the owner's go-ahead (D9) and
is listed in the hand-off as not run.

## Result
Built 2026-10-23, tasks 01 to 11 done. Nothing is committed. The full list, with what ran against what and what did not, is
`.claude/completions/2026-10-23-inbound-sources.md`. In short: the gate is green except three tests (the licence line, which is the
owner's call; a teardown deadlock in `test/model/workers.test.ts`; a `read.plans.aux` load flake). Chromium e2e is 34 pass and 1
fail (the stale `webhooks.e2e.ts`). Nothing ran on a real cloud, in Docker, or in Firefox or WebKit, and the security review is a
self-review.
