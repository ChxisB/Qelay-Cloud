# R11: decoded payload cap (review F5, security finding F-2)

Date: 2026-10-19. Tracker: `.claude/.planning/review-2026-10-19/CURRENT.md`.

## What changed

- `packages/store-postgres/src/store/payloadShape.ts` (new): `overShape`, `MAX_PAYLOAD_NODES` (20,000), `MAX_PAYLOAD_DEPTH` (64).
- `prepare.ts` (job data), `jobEdits.ts` (`updateData`), `complete.ts` (`encodeResult`): refuse before encoding.
- `errors.ts`: `PayloadTooComplexError`; `control-api/src/errors.ts` maps it to 413 `payload_too_large`.
- Store options `maxPayloadNodes`, `maxPayloadDepth`. Docs: limits (table row and section 13), known-issues row 1, security
  review and threat model (F-2 narrowed), release checklist item 2, OpenAPI 413 text.

## Verify

- `bun run test:model` 31 pass. `bun test ./packages/store-postgres ./packages/control-api ./packages/core` 2428 pass, 22 skip.
- `bun test ./packages/sdk ./packages/maintenance` 593 pass. typecheck, lint (panel warnings only), format:check,
  architecture, docs:check pass.

## Not done / owed

The list route still decodes a page whole (about 700 MB for 500 worst-case jobs). Rows stored before the limit are not
rechecked. The default number is the owner's decision.
