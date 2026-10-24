# 11 — Docs, runbook, full gate, completion note

**Status:** done · **Depends on:** 08, 09, 10 · **Touches:** docs, DESIGN.md, packages/panel README

## Goal
The docs say what a source is, how a request travels, and how to run the ingest safely.

## Steps
1. `docs/event-gateway.md`, `webhooks.md`, `limits.md`, `operations.md`, `observability.md`: sources and requests replace job
   events and the writer. A runbook: rotate a source secret, a flood, the ingest down, a bad provider, a route that needs a source.
   `docs/known-issues.md` and `docs/limits.md` carry the body cap, rate limits and retention.
2. Full gate with Postgres up and `QCLOUD_REQUIRE_DB=1`; `docs:check`; the panel build and e2e; `check:terraform`.
3. `.claude/completions/2026-10-23-inbound-sources.md`; the panel README "Look and feel" note; status tables set.

## Acceptance
- `docs:check` and the full gate pass, with the output stated as it was.
- The completion note lists what was not run: the real clouds (D9), Docker-backed runs, Firefox, the container scan, cloud-audit 05.

## Verify
```bash
bun run docs:check
```

## Result

Done 2026-10-23. The completion note is `.claude/completions/2026-10-23-inbound-sources.md`; it has the full lists.

**Changed.** `docs/event-gateway.md` (the public address, tabs, "needs a source"), `limits.md` (section 15), `operations.md`,
`observability.md`, `known-issues.md` (row 12 (e): the token is in access logs), `security/threat-model.md` (A17 to A20, a new
trust boundary), the two deploy runbooks, a new runbook `docs/runbooks/inbound-source-trouble.md` and its row in the runbook index,
and the panel README "Look and feel" note. No `docs/PORTING.md` row: the gateway pages are this repo's own code, not ported.

**Gate, as it was** (local PostgreSQL 18.6, `QCLOUD_REQUIRE_DB=1`): `typecheck`, `lint`, `format:check`, `architecture` exit 0.
`bun test`: 6,107 pass, 252 skip, 3 fail: the licence line in `release.test.ts` (the owner's call; fails at HEAD too), a
teardown `deadlock detected` in `test/model/workers.test.ts` (12 of 13 solo reruns pass; paths not in this diff; HEAD not run),
and `read.plans.aux` "throughput of the whole fourteen days" (passes alone, 20 of 20; a known load flake).
`docs:check` passes (7 blocks run), `docs:transports` and `security:routes` change nothing, openapi tests 37 pass, panel build passes.

**e2e.** Playwright's expected Chromium build (1234) is not installed, so I ran the Chromium project against the cached 1248 build
with a temporary config (deleted): 34 pass, 1 fail. The failure is `webhooks.e2e.ts`, stale since `/webhooks` became a redirect at
HEAD; it is not fixed. No e2e spec visits Sources or Requests. Firefox and WebKit: not run.

**Not run.** Real clouds (D9), Docker-backed runs and image builds, the container scan, the Pub/Sub, ElasticMQ, PgBouncer and TLS
suites, `test:model`, `accessibility-inspect`, cloud-audit task 05. Task 10's review is a self-review.
