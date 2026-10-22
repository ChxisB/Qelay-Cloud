# 17 — Docs gate handoff

**Status:** done · **Depends on:** 16 · **Touches:** docs, .claude/completions

## Goal
Docs, the full gate, a hand review and the completion doc.

## Steps
1. Update `docs/event-gateway.md`, `docs/webhooks.md`, `docs/limits.md`, `docs/known-issues.md` if needed; correct the earlier 'inconsistency' note.
2. Full gate with Postgres up; `docs:check`; hand review of secrets and SQL built from input.

## Acceptance
- The gate in CLAUDE.md passes with `QCLOUD_REQUIRE_DB=1`, apart from the LICENSE test that fails at HEAD.
- The completion doc lists what ran and what did not.

## Verify
```bash
bun run typecheck && bun run lint && bun run format:check && bun run architecture && bun test
```

## Risks / notes


## Result
Docs updated: event-gateway.md (five tabs, saved destinations, stateful issues, editing, hold vs ignore, API table, upgrading 17-19, Not built rewritten), webhooks.md (new fields, delay and dedupe, PATCH, three off states), limits.md section 12, known-issues rows 13-14, operations.md rolling back 16-19, CHANGELOG; openapi enabled/issues text corrected. Gate from repo root on local PG 18.6 with QCLOUD_REQUIRE_DB=1: typecheck, lint (exit 0, 108 warnings), format:check, architecture, docs:check pass; bun test 5642 pass, 252 skip, 1 fail (LICENSE test, the owner's call, fails at HEAD). Hand review: no SQL built from input in the new store code (every unsafe() is parameterised), URLs validated with validateWebhookUrl, audit rows hold ids only. Not run: Playwright e2e, Docker-backed suites, test:model, check:terraform, any real cloud write.
