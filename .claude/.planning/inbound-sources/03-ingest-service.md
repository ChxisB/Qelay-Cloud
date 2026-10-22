# 03 — packages/ingest: the request path

**Status:** todo · **Depends on:** 02 · **Touches:** packages/ingest

## Goal
A public HTTP listener that checks, stores and answers, and does nothing else.

## Steps
1. A `Bun.serve` listener: `POST|PUT|PATCH|DELETE /s/:token` (GET, HEAD off by default). Order: lookup by token hash, method, size and content-type caps, rate limit (429), verification, accept (task 02), the source's configured answer.
2. A rejected request is stored with a cause under a per-source cap; the answer for a bad token is the same shape as for an unknown one.
3. Config from env (database, key, caps); no secrets in logs; a `/healthz`.
4. `bun run architecture` rule: the ingest imports the store and core only, never a transport or the sender.

## Acceptance
- Each check has a test that proves it runs before any write (a counting store).
- Oversize, slow and malformed bodies are refused within the cap and the timeout (tests).
- A valid HMAC request creates one event per enabled route (test on Postgres); a wrong secret creates none and stores a rejection.
- Files are under 300 lines.

## Verify
```bash
QCLOUD_REQUIRE_DB=1 bun test packages/ingest && bun run architecture && bun run typecheck
```

## Risks / notes
- Gate: a new package and a public listener. Security review is task 07.

## Result
