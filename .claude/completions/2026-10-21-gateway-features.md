# Gateway features (G1 to G5) — 2026-10-21

Plan: `.claude/.planning/gateway-features/` (tasks 01 to 17). Decision: D13 in [DESIGN.md](../../DESIGN.md). Authorised by the
owner on 2026-10-21 ("I'm happy for you to implement the new features and ui changes. No need to ask me :)").
Follows [gateway-ui](2026-10-21-gateway-ui.md).

## What changed

| Area | Change |
| --- | --- |
| Core | `webhookRules.ts` (name, description, delay and dedupe validators, `dedupeValues`, `WEBHOOK_HOLD_REASON`), `webhookIssue.ts`, pause modes, `MAX_DESTINATIONS`. |
| Store | Migrations **17** (name, description, `delay_ms`, `dedupe`, `qcloud_webhook_dedupe`), **18** (`qcloud_webhook_issues`, backfill of failing or paused routes) and **19** (`qcloud_webhook_destinations`, nullable `destination_id`). Writer applies delay and dedupe; `update`, `setEnabled(mode)`, issues, grouped stats and destinations. All forward-only and additive. `schema.snapshot.txt` regenerated and reviewed; planned-query rows added. |
| Control API | `PATCH /webhooks/{id}`; `mode` on `PUT /webhooks/{id}/enabled`; `GET /webhooks/issues`, `PUT /webhooks/issues/{id}`; `GET /webhooks/stats?groupBy=webhook`; `GET`/`POST /webhooks/destinations`, `PATCH`/`DELETE /webhooks/destinations/{id}`; `destinationId` on create. Audit rows hold ids only. Deployment warnings no longer count an operator hold or an ignored issue. |
| Panel | Connections list with a last-24-hours trend and names; editable Settings; Pause (hold) and Disable (ignore); stateful Issues in four tabs; Destinations page and a Saved destination kind in New connection; name, description, delay and dedupe on create. An older server is detected (404 or 405) and the old behaviour is kept. |
| Docs | `docs/event-gateway.md`, `webhooks.md`, `limits.md` (section 12), `known-issues.md` (rows 13, 14), `operations.md` (rolling back past 16 to 19), `openapi.yaml`, generated route references, `CHANGELOG.md`. |

Two corrections made on the way:

- `docs/openapi.yaml` said that after a disable the deliveries already queued "are still sent". The store stops sending at once
  and the waiting deliveries go out on enable (unless 24 hours have passed). The text now says that.
- The earlier note of an "inconsistency between openapi and docs/webhooks.md" was two states, not a conflict: a hand-disabled
  webhook (ignore, `pausedBy` null) and a paused one (hold or failures). `webhooks.md` now has a table of the three off states.

## What was checked

The full gate, from the repo root, with local Homebrew PostgreSQL 18.6 on 127.0.0.1:55442 and `QCLOUD_REQUIRE_DB=1`, each command on its own:

| Command | Result |
| --- | --- |
| `bun run typecheck` | pass (exit 0) |
| `bun run lint` | exit 0, 108 warnings, 0 errors |
| `bun run format:check` | pass (1687 files) |
| `bun run architecture` | pass (1714 files within 300 lines; no broker named outside `packages/transports`) |
| `bun run docs:check` | pass, with the documented command blocks run against Postgres |
| `bun test` | **5642 pass, 252 skip, 1 fail** (5895 tests, 593 files, 783 s) |

The one failure is `test/docs/release.test.ts` "every package is MIT…": it expects the line `Copyright (c) 2024 Egeo Minotti`
in `LICENSE`, and HEAD removed it (`4103cee`, "drop upstream copyright line from LICENSE"). It fails the same without this
work and is the owner's call (the MIT notice on ported code, `CLAUDE.md`). Nothing else failed. The 252 skips are the Docker,
PgBouncer, TLS, Pub/Sub emulator and ElasticMQ suites.

Feature tests added: core rules (7), store update, hold, issues, grouped stats, destinations, rules writer (9), Control API
(PATCH, issues, grouped stats, destinations, openapi pin) and the panel (1804 panel tests in all, from 1731 before task 13).

## Not run, owed, or not verified

- **Not started:** D12 inbound HTTP sources (a separate plan with security gates).
- **Not run:** Playwright e2e and the 390 and 1440 px sweeps (`packages/panel/e2e/webhooks.e2e.ts` is stale against the new page).
  Docker, PgBouncer, TLS, Pub/Sub emulator and ElasticMQ suites (skipped, no Docker here). `test:model` (no core queue change).
  `check:terraform` (nothing under `infra/` changed). No `terraform apply`, no `gcloud` or `aws` write.
- **Not verified against a real server:** the panel was tested against a fetch stub that mirrors the routes, not against a
  running Control API.
- **Unmeasured costs** ([limits.md](../../docs/limits.md#12-webhooks-task-52)): the extra `settleIssues` statement per
  recording batch, the grouped stats read, the dedupe table.
- **Flakes, not caused here:** the tick-lateness real-timer test under parallel load; `read.plans.aux.test.ts` "throughput of
  the whole fourteen days" on local PG 18.6. The LICENSE test fails at HEAD (the owner's call).
- **Known limits** (also in `docs/event-gateway.md` "Not built" and `known-issues.md`): a connection cannot be detached from its
  destination; changing a destination does not reset a connection paused for failures; no try-it panel for filter and shape
  (the API has `POST /webhooks/preview`); the panel's Home list derives gateway issues from connections, so an ignored issue
  still shows there; the Issues tab shows the newest 200 with no paging; the list's toggle and actions are not capability-gated;
  the New connection form polls the destination list; the browser's own `type=url` check can pre-empt the form's message.
- About 108 `react` lint warnings (the `set-state-in-effect` pattern the panel already uses, three in gateway files) and no errors.

## Needs the owner

- Commit, push, publish, version bump (none done; the tree is uncommitted).
- The Hookdeck screenshots in the session scratchpad (`hookdeck/shots/`) show real names: delete them.
- Whether D12 inbound sources go ahead, and the LICENSE test.
