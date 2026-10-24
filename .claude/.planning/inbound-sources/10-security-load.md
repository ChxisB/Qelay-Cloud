# 10 — Security review and load check of the ingest path

**Status:** done · **Depends on:** 07, 04 · **Touches:** packages/ingest, scripts/

## Goal
The public path has been reviewed and measured, and the findings are fixed or recorded.

## Steps
1. Run the `security-review` skill over the ingest, `acceptRequest` and the sender change: input handling, constant-time
   compares, secret storage, log redaction, SQL built from input, SSRF, header handling, storage growth. State that it is a
   self-review.
2. `scripts/ingest-load.ts` posts at a set rate against local Postgres and prints accepted, rejected and 429 counts, p99
   latency and the connections held against `budget()`.

## Acceptance
- Every finding is fixed with a test or recorded in `docs/known-issues.md` with the reason.
- The load script runs and its table is in the Result (rate, counts, p99, connections).

## Verify
```bash
QCLOUD_REQUIRE_DB=1 bun scripts/ingest-load.ts --seconds 10
```

## Result

**This is a self-review** by the author of the code, with the `security-review` method, not an independent one. An
independent review is owed.

**Read.** `packages/ingest/src/*` (handler, verify, body, server, rateLimit, main, config, redact), `acceptRequest`,
`rejectRequest`, `clipPairs` and the credential code in `packages/store-postgres/src/store/`, and the sender change
(a delivery of a request takes the request's own body and content type, never its headers).

**Held, with the test that shows it.**
- *Compares:* a signature, key or password is hashed and then compared with `timingSafeEqual`; both the current and the
  previous secret are always tried, and both the user and the password of a Basic header; one answer for every kind of
  wrong credential (`handler.test.ts`, `verify.test.ts`).
- *Secrets at rest:* a URL token is stored as its SHA-256 (256 random bits); a source's secret is sealed with the webhook key;
  `authorization`, `cookie`, `proxy-authorization`, `set-cookie` and the verification header are redacted before storage
  (`ingest.db.test.ts`).
- *Logs:* the handler logs the error's name only, once in ten seconds; no header, body, token or path reaches it
  (`handler.test.ts`, 503 case). The start-up error path redacts every environment value that looks like a secret.
- *SQL:* every statement in the accept and reject path is a tagged template with bound parameters; the token never reaches SQL
  unhashed; the path must match `^/s/qin_[A-Za-z0-9_-]{43}$` before the store is asked.
- *SSRF:* the ingest calls no URL. A destination is called by the sender, behind the existing destination checks.
- *Headers and sizes:* the body cap holds three ways (declared length, counted stream, socket limit), a read deadline cuts a
  slow body, an over-long content type is a 400, at most 64 headers and 64 query pairs of 2,048 characters are kept, NUL is
  removed, and `__proto__` is an ordinary key.
- *Enumeration:* an unknown, a disabled and a removed token answer alike; a method that is not taken is refused the same
  for every token before the store is asked.
- *Storage growth:* a rejected request keeps no body and is stored at most 60 a minute per source across processes.

**Findings.** No defect that needed a code change. Four limits are recorded in `docs/known-issues.md` row 12: (a) a flood of
random tokens uses up the global rate, (b) a holder of the token can use up a source's rate and its stored rejections,
(c) a signed request carries no timestamp, so it can be replayed, (d) the query and the other headers are stored as sent.
(a) was measured, below. The per-address limit is the edge's (Cloud Armor, WAF), where the client address is known.

**Load check** (`scripts/ingest-load.ts`, Postgres 18.6 on this Mac, client and server in one process and one event
loop, so the rates are a floor; pool of 2 connections, as the deployed ingest has):

```
QCLOUD_REQUIRE_DB=1 bun scripts/ingest-load.ts --seconds 10

capacity  (limits lifted, 10 s)
  real sender      200/s  sent   1920  200:1920                   p50 2.6 ms  p99 6.4 ms
  stored 1920 accepted requests for 1920 answers of 200; connections held 2 of 2 budgeted
defaults  (per source 600/min, global 6000/min, 10 s)
  real sender      200/s  sent   1920  200:600 429:1320           p50 1.0 ms  p99 4.9 ms
  stored 600 accepted requests for 600 answers of 200; connections held 2 of 2 budgeted
flood  (per source 600/min, global 6000/min, 10 s)
  real sender        5/s  sent     47  200:14 429:33              p50 1.3 ms  p99 10.2 ms
  random tokens   2000/s  sent  19000  404:5986 429:13014         p50 1.4 ms  p99 4.9 ms
  stored 14 accepted requests for 14 answers of 200; connections held 2 of 2 budgeted
```

The script exits 1 if the requests stored differ from the 200s answered, or if the connections held pass `budget()` for one
process. Neither happened. Reading it: the store keeps up with 192 posts a second on two connections (192, not 200: the
client's pacing); the per-source limit gives exactly 600 in the minute; and the flood took the global rate in about three
seconds, after which the real sender had 429 for the rest of the minute (14 of 47 accepted).

**Not run.** Any other host or CPU count; separate client and server processes; a real load balancer, Cloud Armor or WAF in
front; a minute boundary falling inside a run (the fixed-minute window can allow up to twice the rate across it); a
slow-loris on the headers (the socket's idle timeout is the only defence, not measured).
