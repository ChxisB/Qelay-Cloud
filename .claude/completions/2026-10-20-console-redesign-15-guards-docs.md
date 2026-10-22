# Console redesign 15: guards, docs, PORTING row

Date: 2026-10-20 · Plan: `.claude/.planning/console-redesign/15-guards-docs.md`

## Changed
- New `packages/panel/test/design-rules-guard.test.tsx`: no opt-out of the global 3px focus outline; the six state glyphs differ in shape and are decorative.
- `packages/panel/test/accent-split-guard.test.ts`: wording of the white-text rule only (the stale "orange, 2.61:1" reason became "primary is dark green or pale mint").
- `packages/panel/src/pages/Queues.tsx`, `packages/panel/src/pages/QueueDetail.tsx`: three links lose a 2px focus ring so the global 3px outline applies.
- `docs/PORTING.md`: a redesign row under "Panel, Changed". `packages/panel/README.md`: a "Look and feel" section.

## Checked
- The six guards ran green before and after: 53 pass first, none loosened. `ui-primitives-guard` and `brand-assets` had been updated deliberately in earlier tasks (smaller `rounded-md` allowlist, "Cloud console" subtitle).
- `bun test packages/panel`: 1516 pass, 0 fail. typecheck, lint, `format:check`, `architecture`: clean. `shared/` and `src/lib/auth/` diffs empty.
- `bun run docs:check`: passed (links, fences, imports, config reference).

## Owed or not run
- `docs:check` did not run the documented commands (Postgres down); no command block was changed.
- Two hand-rolled pills (Queues Paused/Active, Overview Live/Paused) keep a dot, not a per-state glyph.
