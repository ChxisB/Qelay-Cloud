# 13c — Benchmark, Fleet and Settings

**Status:** done · **Depends on:** 03, 04b, 05 · **Touches:** packages/panel/src/pages (control/Benchmark, benchmark/*, Fleet, Settings, settings/*), test, e2e
**Design:** https://claude.ai/artifact/TMMbZ97jDRzvSpWiFVKRuG, board "SystemMore" (SX1 to SX10)

## Goal
Fill the benchmark bars and draw the fleet as nodes, and move four confirms into the page, keeping Clean as approved.

## Steps
1. Read the board, `DESIGN-MAP.md` ("Benchmark, Fleet and Settings", SX1 to SX10) and the files above with their tests.
2. Benchmark: bars fill with a `scaleX` slide, never by animating width (SX3); the throughput line draws once. A value over its
   limit shows a red field and a dimmed Run (SX6); limits and hints are the panel's own.
3. Fleet: nodes with `ConnectionNode`; health is a glyph and a word, "active" is a word and not only a border (SX7). "Refresh all" is
   `aria-disabled` while it runs; the error page draws the banner with an empty node grid.
4. Settings: group labels become bold sentence case (SX4, a deliberate change from tracked capitals). Tokens are never shown or
   kept: the field shows bullets, Show and Hide only swap the field's type, and nothing is stored (SX8).
5. Replace these four call sites with `confirmInPage`, same API calls:
   `benchmark/useBenchmarkOperations.ts` (line 64 and line 148: Run and Clean), `pages/Fleet.tsx` (line 67, Stop and Restart node),
   `settings/useConnectionProfileEditor.ts` (line 193, Remove profile). Titles the board adds are new wording, approved 2026-10-22.
6. **Keep as today** (approved 2026-10-22, SX2): Clean acts only on the dedicated benchmark queue this browser session owns.
   Only its confirm moves into the page. Do not add any other purge, drain or clean control.
7. Edit the tests and e2e that stub the dialog or pin old markup in the same change.

## Acceptance
- All four confirms ask in the page, call the same API on true and nothing on false.
- Clean still refuses any queue other than the session-owned benchmark queue (the existing drain-termination tests pass).
- No token is rendered as text, stored, or logged; the field type toggles only.
- `queue-settings-operations-hidden` and `mutation-action-guards` pass.

## Verify
```bash
bun test packages/panel/test/benchmark packages/panel/test/fleet packages/panel/test/settings-security packages/panel/test/connection-profile packages/panel/test/connectionstore packages/panel/test/queue-settings-operations-hidden.test.tsx packages/panel/test/mutation-action-guards packages/panel/test/motion-guard.test.ts && bun run typecheck && bun run lint && bun run format:check
```

## Risks / notes
- Benchmark Run enqueues real jobs: the confirm text keeps the target URL and the warning exactly.
- A user who presses Escape in the dialog must leave the benchmark state unchanged (no half-started run).

## Result
Done 2026-10-22.

**Confirms (five call sites, same API calls, nothing sent on No, Cancel or Escape).** New wording, for the owner's word:
- Benchmark Run: "Run the benchmark?" / "Run benchmark", the detail keeps the target URL (`on <url>?`) and the warning.
- Benchmark Clean: "Clean the benchmark queue?" / "Clean queue", a danger question. Still acts only on the session-owned queue.
- Fleet: "Stop this node?" / "Stop node" (danger) and "Restart this node?" / "Restart node".
- Settings: "Remove this connection?" / "Remove" (danger).
Each is lease-first, so a second click while the question is open asks once and sends once: Benchmark holds `operationRef`
across the dialog, Fleet keeps an `asking` set per node id, the profile editor a `removing` ref. Fleet also checks the
action generation after the answer, so a connection edited while the question is open ends the action. Benchmark checks
mounted.

**Benchmark.** Progress bars fill with `scaleX` and `motion-fill` (no width animation, SX3). The Clean result is a glyph and a
sentence that arrives. Run history rows rise in turn on the first load. A value over its limit now turns its field red
(`aria-invalid`) and dims Run (`aria-disabled`, click ignored), and the panel's own "max N" hint says why. **This replaces the
silent clamp, a small behaviour change (SX6, minimal reading); a value under its minimum is not flagged. Needs the owner's word.**
`Button` gained `aria-disabled:` dim classes for it.

**Fleet.** Cards rise in turn on the first load only (a node added later does not), Server and Agent text wash on a change,
the "active" word stays beside the border (SX7), "Refresh all" says "Refreshing…" and is `aria-disabled` until the poll
settles, the first load says "Checking every server node…" over two skeleton blocks. `Card` takes an optional `style` for its
place in a stagger.

**Settings.** No source change: SX8 (token field shows bullets, Show/Hide only swap the type, nothing stored) and the notice
motion were already true, and `settings-security` still passes.

**Tests.** New: `fleet-confirm`, `benchmark-confirm`, `connection-remove-confirm`, `benchmark-motion`. Edited in the same change:
`control-operation-hardening.test.tsx` and `frontend-blockers-hardening.test.tsx` now answer the in-page question with
`answerConfirms()` instead of stubbing `window.confirm`, plus five benchmark tests fixed the same way earlier.

**Ran.** The 13c Verify set (85 pass, 0 fail), the full panel suite (2082 pass, 0 fail, 289 files), root `bun run lint`
(exit 0, only warnings in files this task did not touch), `bun run format:check`, `bun run architecture` (300-line cap) and the
panel `bun run typecheck`, all clean. One failure in the first full run (`control-operation-hardening.part-05`, Database drawer
inert) passed alone and was gone after the two stale stubs were fixed, so it was pollution from an unanswered confirm left in
the global store.

**Not run.** e2e, Postgres-backed tests, the panel build, the panel by eye in a browser (so the new layout classes, the skeleton
blocks, the Fleet card stagger and the `Wash` on Server and Agent text under `truncate` are unseen), Docker. Tests still stub
`window.confirm` in other files, which task 14 removes.
