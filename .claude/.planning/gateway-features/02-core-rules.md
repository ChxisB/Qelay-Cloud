# 02 — Core rules

**Status:** done · **Depends on:** 01 · **Touches:** packages/core

## Goal
Constants and validators for a connection's name, description, delay and dedupe, and the hold reason.

## Steps
1. `webhookRules.ts`: `WEBHOOK_NAME_CHARS` 80, `WEBHOOK_DESCRIPTION_CHARS` 500, `MIN/MAX_WEBHOOK_DELAY_MS` (1 s, 1 h), `MAX_WEBHOOK_DEDUPE_MS` (24 h), `DEDUPE_FIELDS`, `validateName`, `validateDescription`, `validateDelay`, `validateDedupe`, `WEBHOOK_HOLD_REASON`, `dedupeKey(spec, subject)`.
2. Export from `index.ts`. Tests first.

## Acceptance
- A name is trimmed, 1 to 80 characters, no control characters; null clears it.
- A delay is an integer from 1000 to 3600000; null clears it.
- A dedupe has a window of 1 s to 24 h and 1 to 5 distinct known fields; unknown keys and fields are refused by name.
- `dedupeKey` is the same for equal field values and differs when one differs; it never contains the values (a hash).

## Verify
```bash
bun test packages/core
```

## Risks / notes
The key is a hash so the table never holds an error text.

## Result
`webhookRules.ts` and its test (6 tests): name, description, delay, dedupe validators, `dedupeValues`, `WEBHOOK_HOLD_REASON`; exported from core. `bun test packages/core` 164 pass; typecheck, oxfmt, oxlint clean. A blank name or description clears it (not an error).
