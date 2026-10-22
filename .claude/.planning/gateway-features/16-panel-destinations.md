# 16 — Panel destinations

**Status:** done · **Depends on:** 12 · **Touches:** packages/panel/src/pages/control/gateway

## Goal
A Destinations page (list, add, edit, remove) and a picker on New connection.

## Steps
1. Route, tab, page; the create form offers 'Saved destination' beside 'New address'.

## Acceptance
- A connection can be made from a saved destination without typing its address.
- Editing a destination says how many connections it changes first.
- Removing one in use shows the 409's reason.

## Verify
```bash
bun test packages/panel/test
```

## Risks / notes


## Result
Destinations page at /events-gateway/destinations (list, add, edit, remove; a viewer reads it with the address hidden) with a fifth Gateway tab. New connection: a 'Saved destination' kind (only offered when the server has saved destinations) with a picker that shows the address; it sends destinationId alone. The same form now also takes name, description, delay and deduplication through ConnectionFields (rulesOf in connectionPatch.ts); a refusal naming an option lands beside that field. Editing an address says how many connections it moves first; removing one in use shows the 409's count. Tests: 1804 panel tests pass, 0 fail (bun test packages/panel from the repo root, Postgres up); typecheck, lint (warnings only), format:check, architecture clean. Not run: Playwright, a real server. The new-connection chips' group id changed to choices-events-to-send, so page-forms-12 asserts that id.
