# Inbound sources, and a gateway that carries what it is sent (D12, D14)

Plan: [.claude/.planning/inbound-sources/CURRENT.md](../.planning/inbound-sources/CURRENT.md), tasks 01 to 11, each with its own
Result. Requested and approved by the owner on 2026-10-23: whatever is posted to a source URL is stored, optionally filtered,
de-duplicated, delayed and reshaped by a route, and delivered to its destination. With no `shape` the destination gets the
body unchanged, with its content type. The fixed `job.*` events and the "Events to send" buttons are gone.

## What changed

- **Design record (01):** `DESIGN.md`: D12 Decided, D14 new, D11 and D13 marked superseded and kept as history.
- **Core (02):** the event document `{ method, headers, query, body }` and dotted paths for filter, shape and dedupe.
- **Migration 20 and the store (03):** `qcloud_sources`, `qcloud_requests`, `source_id` on a route, `request_id` on a delivery;
  `store.sources` (create, list, get, update, rotate secret, rotate token, delete, find by token, accept, reject). Accept makes
  one event per enabled route in one transaction.
- **Sender (04):** a request's own bytes and content type are delivered (`webhookPayload.ts`); a shape sends JSON; a queue route's
  job is named `request.received`. Retention of stored requests.
- **Control API and openapi (05):** ten routes (`/sources`, `/requests`, replay), a route's `source`, three error codes.
- **Migration 21 (06):** removes the job-event pipeline (trigger, writer, `events`, `queue`, `active_from`, route cycles). Old
  routes are kept, disabled, with a reason. The panel lost the event picker.
- **Ingest (07):** new `packages/ingest` (`qcloud-ingest`, `Bun.serve`, no new dependency) and an architecture check that it
  imports only core and the store.
- **Panel (08):** Sources and Requests tabs, a Source picker, a repair for a connection with no source, demo data.
- **Packaging and infra (09):** Dockerfile, release workflow, Helm chart entry, GCP and AWS control-plane `ingest.tf` (opt in,
  `ingest = null` creates nothing), plan assertions.
- **Security review and load check (10):** `docs/known-issues.md` row 12, `scripts/ingest-load.ts`, `docs/limits.md` section 15.
- **Docs (11):** `event-gateway.md`, `webhooks.md`, `limits.md`, `operations.md`, `observability.md`, `known-issues.md`,
  `security/threat-model.md` (A17 to A20, a new trust boundary), `reference/configuration.md`, deploy runbooks, and a new
  runbook `docs/runbooks/inbound-source-trouble.md`. Panel README "Look and feel" note.

208 files changed against HEAD (3,181 added, 3,997 removed) and 78 new files. Nothing is committed.

## What ran, and against what

All on a local PostgreSQL 18.6 (Homebrew, `127.0.0.1:55442`, the compose settings, `QCLOUD_REQUIRE_DB=1`). Docker was not used.

- `typecheck`, `lint` (warnings only), `format:check`, `architecture`: exit 0.
- `bun test`: **6,107 pass, 252 skip, 3 fail** (6,362 tests, 659 files, 912 s). The three failures:
  1. `test/docs/release.test.ts`, "package metadata ... carries a licence file": the per-package `LICENSE` files still carry
     `Copyright (c) 2024 Egeo Minotti`, and the root `LICENSE` dropped it in 4103cee. It fails at HEAD too. **The owner's call.**
  2. `test/model/workers.test.ts`, an unnamed failure: `deadlock detected`. The test teardown (`DROP SCHEMA ... CASCADE`) took
     its lock after a worker's `SELECT ... FROM qcloud_queue_state` was still running. It passed in 12 of 13 solo reruns. None of
     the paths involved (`test/model`, `test/support`, `packages/sdk`, the queue-state readers) is in this diff, but I could not run
     HEAD to prove it was there before. A teardown race, not fixed.
  3. `read.plans.aux.test.ts`, "throughput of the whole fourteen days": a `Sort` node in a plan under load. It passes alone
     (20 of 20). The `read.plans.*` family is known to flake under load.
- The 252 skips are the opt-in suites whose service was not running: Pub/Sub emulator, ElasticMQ, PgBouncer, TLS Postgres.
- `docs:check` (7 documented blocks run), `docs:transports` and `security:routes` (no change), openapi tests (37 pass),
  `bun run --cwd packages/panel build`, the panel suite with its guard tests (inside `bun test`).
- `check:terraform` ran in task 09 (`QCLOUD_REQUIRE_TERRAFORM=1`, plan only, no credentials). `infra/` did not change in task 11.
- **e2e, Chromium only:** Playwright wants `chromium_headless_shell-1234`, which is not installed (the cache holds 1243 and 1248).
  I ran the Chromium project with a temporary config that points at the cached 1248 build (the file is deleted). **34 pass, 1 fail.**
  The failure is `e2e/webhooks.e2e.ts`, which looks for a `/webhooks` navigation link. At HEAD `/webhooks` already redirects to
  `/events-gateway` (`App.tsx`), so the spec was stale before this work. Not fixed: it needs a rewrite for the gateway pages.
  No e2e spec visits the new Sources or Requests pages, so the axe scan in `e2e/fixtures.ts` did not cover them.
- **Web design guidelines**, on the nine new panel files: two findings, both fixed (button names on the source card and the
  request row). Left: Title Case against the panel's sentence-case rule, no virtualised list, the Newer/Older position not in the address.
- **Accessibility:** `accesslint` returned page-level findings on `<html>` only (no landmark, no h1) because it saw the unrendered
  shell. That is not counted as a result. `accessibility-inspect` (keyboard and focus on the new form and detail pane) was not run.
- **By eye:** demo mode on the Vite server, 1280 by 900, dark theme. Light theme, phone width and the detail pane were not looked at.

## Not run, or owed

- Any real cloud (D9): no deployed ingest, no real provider posting to it, no load balancer, Cloud Armor or WAF has seen a request.
- Docker: no image was built (the install step was emulated), no container scan, no SBOM, no compose or PgBouncer/TLS profile.
- Pub/Sub emulator and ElasticMQ suites, `test:model` (queue semantics are unchanged), Firefox and WebKit.
- Cloud-audit task 05 (needs the D9 go-ahead and a spend ceiling).
- An independent security review. Task 10 is a self-review.
- Load numbers come from one process on one CPU (client and server share it), a floor and not a deployed figure.

## Decisions and deviations to confirm

- Migration 21 is **not rolling-safe**. The CLAUDE.md two-release rule protects a shipped release and none exists; the owner chose
  one forward migration on 2026-10-23.
- The namespace-isolation trigger test and the `webhook.cost` measurement were deleted with the trigger.
- The create response for a source carries the URL **token**, not a URL (the Control API does not know the ingest origin). The
  panel shows `/s/<token>` and says to post to the ingest address followed by it.
- `qcloud_requests` is a plain table with a retention index, not partitioned. A source's verification kind cannot be edited.
- Rejected requests keep no body and are stored at most 60 a minute per source (D12 gave no number).
- The token is in the URL, so the platform's and the load balancer's access logs hold it (`known-issues.md` row 12 (e)). The
  ingest logs no path.
- No ingest 5xx alert was built. The runbook says to check by hand.
- The AWS WAF host match is a prefix match; avoid host names that begin with the ingest's.
- The Helm and Docker ingest share no workload identity.
- `scripts/ingest-load.ts` is not registered in `package.json`.
- A scratch database started with `synchronous_commit=off` and trust auth made two tests fail; it was restarted with the compose
  settings (see the task 06 Result).
- Task 07 and task 05 deviations are in their Results. Panel limits (no last request on a source row, no rename, no list-level
  repair, connection labels read `Source: <id>`) are in the task 08 Result.

## Needs the owner

The licence line, the stale `webhooks.e2e.ts`, and sign-off on the migration 21 decision. Real-cloud runs and an independent
review of the ingest before it faces the internet. Nothing was committed, pushed, tagged or published.
