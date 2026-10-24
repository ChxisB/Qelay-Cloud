# 02 — Core: filter, shape and dedupe work on a request document

**Status:** done · **Depends on:** 01 · **Touches:** packages/core

## Goal
`filter`, `shape` and `dedupe` take any dotted path into a JSON document, so the same rules serve a request body as well as the
seven job fields they know today.

## Steps
1. `webhookFilter.ts`: a field is a dotted path (`body.id`, `headers.x-event`), at most 8 segments of 64 characters, no empty
   segment, no `__proto__`, `constructor` or `prototype`. `matchesFilter` reads the path from a plain document. The seven job
   fields are top-level paths, so existing filters stay valid. `SUBJECT_FIELDS` stays until task 06.
2. `webhookShape.ts`: `{ "$": "path" }` reads the same paths; a missing path renders as `null`, as today. The preview takes a
   sample document.
3. `webhookRules.ts`: `dedupe.fields` become paths (up to 5), not the five `DEDUPE_FIELDS`. `dedupeValues` reads them from the
   document. Existing `["event","jobId"]` style values stay valid.
4. A document is `Record<string, unknown>`; `WebhookSubject` becomes an alias of it.
5. Tests: a filter, a shape and a dedupe over `{ body: { id: 500, name: "chris" }, headers: {}, query: {}, method: "POST" }`; a
   prototype-pollution path is refused; the existing core suites pass unedited.

## Acceptance
- A filter `{ "body.id": { "$gt": 100 } }` matches the document above and `{ "body.id": { "$gt": 900 } }` does not.
- A shape `{ "who": { "$": "body.name" } }` renders `{"who":"chris"}`.
- A path through `__proto__` is rejected when the rule is saved.
- Every existing `packages/core` webhook test passes without being edited.

## Verify
```bash
bun test packages/core && bun run typecheck && bun run lint
```

## Risks / notes
- Paths are data, never code. The reader only walks own properties of plain objects and arrays.

## Result
Done 2026-10-23. `webhookPath.ts` (new: `isDocumentPath`, `readPath`, tests), `webhookFilter.ts`,
`webhookShape.ts` (adds `previewRequest`), `webhookRules.ts` (dedupe fields may be document paths, up to 5), `index.ts` export,
`webhookRequest.test.ts` (new). The seven job fields stay valid top-level fields, so the old suites pass unedited.
Ran on scratch Postgres 18 (127.0.0.1:55442): `bun test packages/core` 200 pass; typecheck, lint, format:check and architecture
green. Full `bun test` with `QCLOUD_REQUIRE_DB=1` on the same Postgres: 5973 pass, 252 skip (the Pub/Sub, ElasticMQ, PgBouncer and
TLS suites, whose services are not up), 1 fail, 838 s. The one failure is `test/docs/release.test.ts` ("every package is MIT ...
carries a licence file"): the per-package `LICENSE` files still have the line `Copyright (c) 2024 Egeo Minotti` and the root
`LICENSE` does not, since commit 4103cee. No LICENSE file is in this task's diff, so it is not caused by it. Left as it is: it is
licence text, and the test was not loosened. It is the owner's call (hand-off item).
