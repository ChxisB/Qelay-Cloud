# 12 — Panel client

**Status:** done · **Depends on:** 11 · **Touches:** packages/panel/src/lib

## Goal
Types, parsers and client calls for everything above.

## Steps
1. `WebhookFull` gains name, description, delay, dedupe, pausedBy; issue, destination and grouped-stats types; payload parsers; `bq` methods.

## Acceptance
- Parsers refuse a malformed payload by name and tolerate the old shape (an older server).
- Each call hits the right path, method and body.

## Verify
```bash
bun test packages/panel/test
```

## Risks / notes


## Result
Panel client: types (gatewayTypes.ts), route fields (name, description, delayMs, dedupe, pausedBy, destinationId; an older server defaults them, pausedBy derived), parsers in gatewayFeedPayloads.ts (issues, issue, grouped stats, destinations), and bq calls updateWebhook, setWebhookEnabled(id, enabled, mode?), webhookIssues, setWebhookIssueStatus, webhookGroupStats, destinations, addDestination, updateDestination, removeDestination. Tests: gateway-feed-payloads (48) and gateway-client (8) in packages/panel/test. Dedupe with no fields is now refused like the server does. Ran: panel suite 1731 pass / 0 fail, typecheck, oxfmt, architecture clean, oxlint exit 0 (existing panel warnings only, no import-cycle warning). Not run: against a real server, Playwright.
