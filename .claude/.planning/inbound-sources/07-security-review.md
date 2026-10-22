# 07 — Security review and load check of the ingest path

**Status:** todo · **Depends on:** 03, 04 · **Touches:** packages/ingest, scripts/

## Goal
The public path has been reviewed and measured, and the findings are fixed or recorded.

## Steps
1. Run the `security-review` skill over the ingest, the accept step and the sender change: input handling, constant-time compares, secret storage, log redaction, SQL from input, SSRF, header handling, storage growth.
2. A load script posts at the configured rate against local Postgres and reports accepted, rejected and 429 counts, p99 latency and the connections held (against `budget()`).

## Acceptance
- No unresolved high or medium finding; the rest are recorded with a reason.
- The load result and the connection count are in the Result with the hardware they came from.

## Verify
```bash
QCLOUD_REQUIRE_DB=1 bun test packages/ingest && bun run scripts/ingest-load.ts
```

## Risks / notes
- Local numbers only; real-cloud numbers need the owner's go-ahead (D9).

## Result
