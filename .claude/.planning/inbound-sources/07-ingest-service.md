# 07 — packages/ingest: the public request path

**Status:** done · **Depends on:** 03 · **Touches:** packages/ingest, scripts/architecture rules
**Gate:** new package and public listener, no new dependency (approved 2026-10-23)

## Goal
A public HTTP listener that checks, stores and answers, and does nothing else.

## Steps
1. `Bun.serve`: `POST|PUT|PATCH|DELETE /s/:token`. Order: lookup by token hash, method, content-length cap (256 KB), a hard read
   timeout and a streamed size cap (a lying length cannot get past), rate limit (429), verification, `acceptRequest`, answer.
   (As built the method and the global rate come before the lookup; see the Result.)
2. Verification: none, HMAC (header name, algorithm sha256, hex or base64, constant-time compare), basic, API key (header).
   The signed bytes are the raw body.
3. A rejected request is stored with a cause under the per-source cap. A bad token answers exactly as an unknown one.
4. Config from env (database URL, `QCLOUD_WEBHOOK_KEY`, caps, port), secrets never logged, `/healthz`, graceful shutdown.
5. Headers are stored redacted (CURRENT.md, D14).
6. `bun run architecture`: ingest imports store and core only, never a transport or the sender.

## Acceptance
- Each verification kind accepts a correct request and rejects a wrong one with the same status and body shape (test).
- An oversized body, a slow body and a lying content-length are cut off without a stored body (test).
- A 429 is returned past the rate and the stored-rejection cap holds (test).
- `authorization` and `cookie` are `[redacted]` in the stored request (test).
- The architecture check fails when the ingest imports a transport (test).

## Verify
```bash
QCLOUD_REQUIRE_DB=1 bun test packages/ingest && bun run architecture
```

## Result
Done 2026-10-23.

**What changed**
- New `packages/ingest` (`@qelay-cloud/ingest`, bin `qcloud-ingest`), no new dependency: only `@qelay-cloud/core` and
  `@qelay-cloud/store-postgres`. Modules: `config` (env, every error repeats no value), `handler` (the request path),
  `verify` (none, HMAC over the raw body, basic, API key; digests compared in constant time), `body` (streamed size cap and
  read timeout), `rateLimit`, `redact`, `server` (`Bun.serve`), `main` (drain on stop, exit 2 for bad settings), `bin`, `index`.
- Order as built: `/healthz`; token shape (`/s/qin_` + 43 base64url, else 404); method `POST|PUT|PATCH|DELETE` (else 405
  with `Allow`); global rate (429); token lookup (null, off or deleted: the same 404); content-type length; per-source rate
  (429, not stored); declared length; streamed read (413 / 408, each stored as a rejection with no body); verification (401,
  one body for every kind, stored with its cause); `accept` (200 `{"id"}`). A database error is 503 with `Retry-After`.
- Headers and query are stored redacted by the store (`authorization`, `cookie` and the source's own verification header);
  a rejection always stores an empty body. All answers carry `cache-control: no-store`; logs hold only the error name, once
  per 10 s.
- Root wiring: project reference, the tooling tsconfig, `bun.lock` workspace entry, the `ingest` root in
  `scripts/transportBoundary.ts`, and new `scripts/ingestBoundary.ts` + `check-ingest-boundary.ts` (run by `bun run
  architecture`; fails when the ingest imports a transport, the sender or any other package) with its test. The ingest is
  also in the log call-site scan (`test/observability/logs.test.ts`).
- Docs: `QCLOUD_INGEST_*` (seven variables) in `docs/reference/configuration.md`, and `packages/ingest/README.md`.

**What ran, and against what** (local PostgreSQL 18.6, Homebrew, as an emulator of the compose service; Docker was not used)
- `bun test packages/ingest`: 50 pass (33 handler/verify/body with a stub store, 8 on a real socket, 9 end to end through the
  real store).
- End to end: `{id:500,name:"chris"}` is stored as sent, `authorization`/`cookie` are `[redacted]`, and a claim hands the
  sender the request's own bytes and content type for each route (no shape, no copy). Each verification kind takes the right
  credential and answers a wrong one 401 with the same body and a stored rejection (cause "verification failed", no body, the
  secret nowhere in it); the HMAC header is stored redacted; the rotated-out secret still verifies. 65 bad requests store 60
  and count 5; a 429 stores nothing and counts nothing; unknown, disabled and deleted tokens answer alike; a rotated token
  stops at once; a body over the cap stores a rejection with no body and makes no delivery.
- `bun run typecheck`, `lint` (warnings are the panel's), `format:check`, `architecture`, `docs:check` (7 documented blocks
  run): exit 0.
- Full `bun test` with `QCLOUD_REQUIRE_DB=1`: 6068 pass, 252 skip, 1 fail. The one failure is the known
  `package metadata > ... carries a licence file` (the owner's call, task 06). The ingest, architecture and log suites were
  run again alone after the last edit (`DELETE` added): 67 pass.

**Not run:** Docker-backed runs, the Pub/Sub, ElasticMQ, PgBouncer and TLS suites (the 252 skips), `test:model` (queue
semantics are unchanged), any real cloud (D9), a load run (task 10), the ingest behind a real load balancer (task 09).

**Deviations and decisions to carry to the final report**
- The method and the global rate limit run *before* the token lookup (the plan had the lookup first). A 405 then does not tell
  a caller whether a token exists, and the global limit caps database lookups. Cost: a flood of well-shaped random tokens
  can use up the global allowance and so shut out real senders for the minute. Per-address limits at the edge are task 09;
  task 10 measures it.
- Rate limits are per process (a `shortcut:` comment in `rateLimit.ts`): `n` instances allow about `n` times the figure.
- A declared Content-Length more than 64 KiB over the cap is cut off by Bun's own 413 before the handler runs: nothing is
  stored for it. Between the cap and that margin the handler answers 413 and stores a rejection.
- 401 has one body for every kind and sends no `WWW-Authenticate`, so a probe learns nothing about the kind.
- The ingest has no `migrate` command: `qcloud-api migrate` owns the schema, and a process reading a table at the wrong
  version stops at start.
