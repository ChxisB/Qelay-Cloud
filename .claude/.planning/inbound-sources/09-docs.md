# 09 — Docs, runbook, completion note

**Status:** todo · **Depends on:** 06, 07, 08 · **Touches:** docs, DESIGN.md

## Goal
The docs say what a source is and how to run the ingest safely.

## Steps
1. `docs/event-gateway.md` gains Sources and Requests; a runbook (rotate a source secret, a flood, the ingest down, a bad provider); `docs/limits.md` (body cap, rate limits, retention); `known-issues.md`.
2. Full gate with Postgres up, `docs:check`, `check:terraform`; completion note in `.claude/completions/`.

## Acceptance
- `bun run docs:check` passes.
- The completion note lists what ran, what did not, and the D9 runs the owner still has to approve.

## Verify
```bash
bun run typecheck && bun run lint && bun run format:check && bun run architecture && QCLOUD_REQUIRE_DB=1 bun test && bun run docs:check
```

## Risks / notes
- No commit or push.

## Result
