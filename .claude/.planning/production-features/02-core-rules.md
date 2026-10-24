# 02 — Core rules and the batch body

**Status:** done · **Depends on:** 01 · **Touches:** packages/core
**Design:** none (reuses existing pages and parts)

## Goal
Pure rules with tests: validation of `batch` and `schedule`, and the batch envelope and its stable id.

## Steps
1. `webhookRules.ts` (or a new `webhookBatch.ts` if the file would pass 300 lines): `validateBatch` ({ maxEvents 1..500 default 100, maxBytes 1 KiB..1 MiB default 256 KiB }), `validateSchedule` shape ({ cron, timezone? }; the cron itself is checked by the store's parser).
2. `buildBatchBody(events)`: { batchId, count, events: [{ id, receivedAt, body }] }; a JSON body is nested, text is a string, bytes are { base64 }. `batchId` is a SHA-256 of the sorted event ids, so the same members give the same id on a retry.
3. Export from the index.

## Acceptance
- Unknown keys, out-of-range sizes and non-http use are refused with UnsupportedOptionError naming the option.
- The same events in any order give the same batchId; one more event changes it.
- A body that is not valid JSON is carried as a string; non-UTF-8 bytes as base64.

## Verify
```bash
bun test packages/core && bun run typecheck
```

## Result
Done 2026-10-23. New `packages/core/src/webhookBatch.ts` (`validateBatch`, `batchId`, `buildBatchBody`, `batchEventBody`, limits and
defaults), `webhookSchedule.ts` (`validateSchedule`, zone checked with `Intl.DateTimeFormat`) and `webhookBatch.test.ts` (13 tests),
both exported from the index. Two files instead of editing `webhookRules.ts`, which keeps each small.

Choices: `batchId` and `buildBatchBody` are async (SHA-256 through `crypto.subtle`, as the rest of core does); an event with no bytes
carries `body: null`; a JSON body that does not parse is carried as its text; a text body is never read as JSON because it looks like it;
base64 goes in 8 KiB slices (the `btoa(String.fromCharCode(...bytes))` used elsewhere overflows the stack on a 256 KiB body, tested);
`validateBatch(value, destination)` refuses a batch on a `queue` route; one event larger than `maxBytes` still goes, alone (documented
on the type, enforced in task 05).

Ran: `bun test packages/core` 232 pass; `bun run typecheck`, `lint` (0 errors), `format:check`, `architecture` clean.
