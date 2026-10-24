# 17 — Docs, gate, hand-off

**Status:** done · **Depends on:** 07, 08, 10, 15, 16 · **Touches:** docs, .claude/completions
**Design:** none (reuses existing pages and parts)

## Goal
Docs say what exists; the whole gate runs; the owner gets the hand-off.

## Steps
1. event-gateway.md, webhooks.md, concepts.md, compat.md, unsupported.md, migration.md, limits.md, operations.md, openapi and reference configuration updated. docs:transports if a capability moved.
2. Full gate with Postgres up and QCLOUD_REQUIRE_DB=1; test:model; panel build; e2e Chromium (stale webhooks spec noted).
3. .claude/completions/2026-10-23-production-features.md. The hand-off starts with 'Written for: ...'.

## Acceptance
- The gate ran and its result is stated as it was.
- Every doc claim has a test or a command behind it.
- Nothing committed, pushed or published.

## Verify
```bash
bun run typecheck && bun run lint && bun run format:check && bun run architecture && QCLOUD_REQUIRE_DB=1 bun test
```

## Result
Done. Docs updated (operations, compat, unsupported, concepts, migration, limits, webhooks, event-gateway, the tick-stopped and
dead-letter-queue-growing runbooks, a new `docs/production.md` linked from the README and the four quickstarts). Completion note:
`.claude/completions/2026-10-23-production-features.md`.

The full `bun test` found two failures. One was mine to fix: `test/gameday/workers.test.ts` asserted `POST /queues/jobs/dlq/retry` is
501 and re-added work by hand. Retry exists now (D16), so the test asserts a call without `confirm` is 400 and retries the four failed
jobs through the route (same ids back to waiting, DLQ empty afterwards). The same stale claim sat in
`docs/runbooks/dead-letter-queue-growing.md`, `docs/migration.md`, `docs/compat.md` (flow-child row) and
`packages/control-api/README.md`; all four are corrected. `docs:check` did not catch any of them. The other failure, the per-package
`LICENSE` text, fails at HEAD too (the owner's call, see the note).

Ran on local Postgres 18 (127.0.0.1:55442) and the Pub/Sub emulator (127.0.0.1:58085), no Docker, no cloud: `typecheck`, `lint`
(0 errors), `format:check`, `architecture`, `docs:check`, `docs:transports`, `security:routes --check`: pass. `bun test`: 6,425 pass,
151 skip, 2 fail (above), 6,579 tests; afterwards `test/docs` and `test/gameday` again: only the licence test fails. `bun run test:model`:
31 pass. Panel build and `bun test packages/panel`: 2,204 pass. Playwright, Chromium only, through a temporary config pointing at the
cached 1248 headless shell (deleted): 34 pass, 1 fail, the stale `e2e/webhooks.e2e.ts` (it looks for a `/webhooks` link; that path has
redirected to `/events-gateway` since before this work).

Not run: SQS emulator suites (ElasticMQ down, so `batch` against SQS is untested), PgBouncer and TLS connection suites, Firefox and
WebKit, any real cloud (D9), Docker, `check:terraform` (nothing under `infra/` changed), an independent security review, an
accessibility scan or keyboard check of the new panel cards, a look at light theme or phone width.
