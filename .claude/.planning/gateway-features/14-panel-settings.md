# 14 — Panel settings

**Status:** done · **Depends on:** 12 · **Touches:** packages/panel/src/pages/control/gateway

## Goal
The Settings tab edits name, description, events, filter, shape, delay and dedupe; Pause holds and Disable ignores.

## Steps
1. An edit form with a preview of the body; saving calls PATCH; a refusal stays on the page with what was typed.

## Acceptance
- Saving sends only what changed; the page shows the server's answer.
- Pause and Disable are two actions with their own words; a held connection says so and Resume is offered.
- A read-only role sees values and no controls.

## Verify
```bash
bun test packages/panel/test
```

## Risks / notes


## Result
Connection settings now edit a connection and stop it in two ways. connectionPatch.ts builds a PATCH with only the changed keys (name, description, events, filter, shape, delay in seconds, dedupe window and fields) and refuses a bad value before sending, naming the field; ConnectionFields.tsx and ConnectionEdit.tsx draw the form, show 'What Save sends', keep typed values on a refusal (the server's details.option puts the words beside its field; Discard also clears the refusal) and show the server's own values after a save. ConnectionPause.tsx offers Pause (mode hold: events keep being collected, Resume sends them) and Disable (mode ignore); routeState has active/held/paused/off with the words Active, Paused, Paused after failures, Disabled. ConnectionPage header Pause/Enable/Resume and a held Banner; viewers get no controls. Decisions: the list switch still means Disable (ignore) and is not gated by useCanOperate; the filter and shape editor is a JSON textarea with grammar checked by the server (POST /webhooks/preview has no try-it UI); the label 'Off' became 'Disabled'. Ran: full panel suite 1759 tests, 245 files (2 failures in home-model.test.ts were fixtures that skip the parser, fixed; re-run of that file passes), bun run typecheck exit 0, format:check clean, architecture exit 0 (settings test split into -pause test to stay under 300 lines), lint exit 0 with warnings only (the same set-state-in-effect warning as elsewhere). Not run: Playwright e2e, 390/1440 sweeps, a real server.
