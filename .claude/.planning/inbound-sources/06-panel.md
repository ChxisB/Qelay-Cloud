# 06 — Panel: Sources and Requests in the Event gateway

**Status:** todo · **Depends on:** 05, event-gateway 11 · **Touches:** packages/panel

## Goal
Sources and Requests are tabs of the Event gateway, as in Hookdeck.

## Steps
1. Sources tab: list with the URL, verification and last request; create form (the secret shown once); the connection list groups routes by source. Requests tab: the log with status and cause filters, a sidebar (headers, query, body, the events it made), Replay.
2. The Connections create form gains a Source picker (a queue's job events, or an inbound source).

## Acceptance
- A source can be created, its URL copied, a request listed and replayed from the panel (e2e on the local stack).
- A viewer sees no secret and no write controls (test).

## Verify
```bash
bun run typecheck && bun test packages/panel
```

## Risks / notes
- The e2e suite may not run in this environment; say so in the Result.

## Result
