# Inbound HTTP sources (D12)

Requested by the owner on 2026-10-21 ("our sources and add inbound HTTP sources too"), after asking for the event gateway UI
to match Hookdeck. Follows the event-gateway plan (`../event-gateway/`). DESIGN.md D12 (section 1 table, section 6 note) is
**Proposed**: the direction is the owner's, the design is not signed off, and **nothing here is built before task 01 is signed off**.

## Goal
A third party (Stripe, Shopify, another service) posts to a public Qelay URL; the request is stored and becomes events on
the routes attached to that source, delivered by the existing sender to an HTTPS URL or a queue.

## Scope
- **In:** a source (name, URL token, verification: none, HMAC, basic, API key), a request log, routes whose source is an inbound
  source, an ingest service, Control API routes, panel Sources and Requests tabs, replay of a request to its own routes,
  Terraform for the ingest service (plan only), docs and a runbook.
- **Out:** JavaScript transforms, delay, dedupe, delivery groups, a CLI or mock destination, replay to another source, per-tenant
  portals, Hookdeck-style platform source presets beyond a generic HMAC (a Stripe preset is a later add).

## Design sketch (the part task 01 asks the owner to sign off; full text in DESIGN.md section 6, D12)
- A separate **ingest** process (a new package, `packages/ingest`), not the Control API and not the tick. It validates, stores,
  answers. It never calls a destination and never reads job state: delivery stays with the tick's sender, which needs the
  outbound network the ingest does not get.
- One transaction per accepted request: insert the request, insert one event (`qcloud_deliveries` row) per enabled route of
  that source. The sender then delivers them exactly as it delivers job events.
- Checks in order, before any write: method allow-list, content-length cap (256 KB default), content-type cap, per-source and
  global rate limit (429), verification (constant-time compare). A rejection is stored with a cause, capped per source per
  minute so an attacker cannot fill the table.
- Secrets: encrypted with `QCLOUD_WEBHOOK_KEY` like webhook secrets; shown once; never returned or logged.
- Retention: the existing maintenance prune, with a request retention of its own.

## Touches
Migration 17 (`qcloud_sources`, `qcloud_requests`, `source_id` and `request_id` columns), `packages/core`, `store-postgres`,
a new `packages/ingest`, `maintenance` (the sender reads a request body for a delivery; retention), `control-api`,
`docs/openapi.yaml`, `packages/panel`, `infra/gcp` and `infra/aws` (plan only), `docs/`, `scripts/` (a load check).

## Human gates (CLAUDE.md), each needs the owner
1. **D12 sign-off** (a decision in DESIGN.md changes): task 01.
2. **Migration 17**: task 02.
3. **New public Control API routes and openapi**: task 05.
4. **A new package and a public listener** (a new dependency if a framework is chosen; the plan uses `Bun.serve`): task 03.
5. **Anything under `infra/`**, and `terraform apply`: task 08 is `terraform plan` only.
6. **Real cloud and anything paid or shared (D9)**: no real-cloud run without the owner's explicit go-ahead.
7. **Security review** (outbound requests, SQL from input, a public endpoint): task 07, before anything is called done.

## Risks
- A public endpoint is the largest new attack surface in the repo: request flooding, oversized bodies, slow bodies, spoofed
  senders, header injection into the stored request, and a stored body replayed to a destination (SSRF is the sender's
  existing check, which must run on the route's destination, never on anything the request carries).
- The connection budget (`budget()`): an ingest at volume must use few, short transactions, or it starves workers.
- A migration that adds `source_id` to routes must keep every existing route on its queue source and old tick binaries working (additive, nullable, default).

## Status

| # | Mini-task | Depends on | Gate | Status |
|---|-----------|-----------|------|--------|
| 01 | D12 design sign-off: the model, the request path, the limits, what stays out | none | **owner sign-off** | todo |
| 02 | Migration 17 and store: sources, requests, a route's source | 01 | **migration** | todo |
| 03 | `packages/ingest`: the request path (checks, verification, store, answer) | 02 | **new package** | todo |
| 04 | Sender: deliver a request's event (body, headers, query as the filter and shape input) | 02 | none | todo |
| 05 | Control API and `openapi.yaml`: sources, requests, replay | 02, 04 | **new routes** | todo |
| 06 | Panel: Sources and Requests tabs in the Event gateway | 05, event-gateway 11 | none | todo |
| 07 | Security review and load check of the ingest path | 03, 04 | none | todo |
| 08 | `infra/`: the ingest service for GCP and AWS (`terraform plan` only) | 03 | **infra** | todo |
| 09 | Docs, runbook, completion note | 06, 07, 08 | none | todo |

Real-cloud verification (a deployed ingest, a real provider posting to it) is not a task: it needs the owner's go-ahead (D9)
and is listed in the hand-off as not run.

## Result
Empty until built.
