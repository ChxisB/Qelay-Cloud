# 04 — Sender: deliver a request's event

**Status:** todo · **Depends on:** 02 · **Touches:** packages/maintenance, packages/core

## Goal
The tick's sender delivers an event that came from a request, with the request's body, headers and query as the input of `filter` and `shape`.

## Steps
1. `ClaimedDelivery` and the claim SQL carry the request (or its id); the renderer takes the request's JSON body, headers and query in place of the seven event fields; a non-JSON body is passed as text.
2. The destination check (HTTPS, not private) runs on the route's destination only, never on a value from the request.
3. Both sender paths (`webhookSender.ts` and `webhookLoop.ts`) are covered.

## Acceptance
- A request event is sent with the shaped body and the same signing, retry and auto-pause as a job event (test).
- A filter on a body field lets one request through and drops another (test).
- The existing sender suites pass unedited.

## Verify
```bash
QCLOUD_REQUIRE_DB=1 bun test packages/maintenance packages/core
```

## Risks / notes
- Depends on the event-gateway sender work (task 09 there).

## Result
