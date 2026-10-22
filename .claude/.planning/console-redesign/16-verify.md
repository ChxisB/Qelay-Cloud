# 16 — Verify and hand off

**Status:** done · **Depends on:** all · **Touches:** .claude/completions

## Goal
Run everything the change calls for, review the diff, and hand over with an honest not-run list.

## Steps
1. `df -h /System/Volumes/Data` first. Use `caffeinate` for long runs.
2. Full gate, with the local Postgres up and `QCLOUD_REQUIRE_DB=1` if it is available.
3. `bun run --cwd packages/panel build`.
4. Playwright e2e (axe on every route, network policy) when Postgres and a browser are up.
5. Screenshots of every route in both themes at 1440 and 390, read against the boards. Say what was compared by eye.
6. `code-review` skill on the diff. `security-review` only if auth or secrets were touched, which this plan forbids.
7. Write `.claude/completions/2026-10-20-console-redesign.md` and update `CURRENT.md`.

## Acceptance
- The gate output is quoted as it was.
- Each skipped check is named with its reason.
- Task 01 is shown as blocked with the exact approval needed.

## Verify
```bash
bun run typecheck && bun run lint && bun run format:check && bun run architecture && bun test && bun run --cwd packages/panel build
```

## Risks / notes
- The boards cannot be rendered locally, so visual parity is judged from the board's CSS and the panel's screenshots, not a
  pixel diff.

## Result

**Gate**, run last on 2026-10-20 after the review fixes, against a Docker-free scratch Postgres 18.6 on 127.0.0.1:55442
with `QCLOUD_REQUIRE_DB=1`: `typecheck=0`, `lint=0` (pre-existing warnings only), `format=0`, `architecture=0` (1585 files
under the 300-line limit), `bun test` exit 1 with **5170 pass / 252 skip / 2 fail**. `bun test packages/panel` from the
repo root: **1524 pass, 0 fail** (running `bun test` from inside `packages/panel` loses the root `bunfig.toml` and fails
129 of the same tests; that is the invocation, not the code).

**The 2 failures, both outside the panel and in code this change does not touch** (the diff is `packages/panel`,
`docs/PORTING.md`, `.oxfmtrc.json` and planning files):
- `test/docs/release.test.ts` "every package is MIT… carries a licence file": fails at HEAD too. The per-package LICENSE
  files still carry the "Copyright (c) 2024 Egeo Minotti" line that commit 4103cee removed from the root LICENSE. A
  licence decision for the owner, not touched.
- `test/model/wfengine/engine.test.ts` "generated graphs and operator histories preserve every invariant": fast-check
  seed 1382233728, run 30, invariant I10 "failure state without failureReason" on a workflow with parallel steps, an
  always-fail compensation and a failing child. **Not reproduced:** the same seed with `QCLOUD_WFMODEL_RUNS=31` passes, and
  two further random-seed runs pass (3 pass each, 604 expects). The model drives real timers (`settle(150ms)`) and that
  gate run shared the CPU with a build and `docs:check`, so I take it as a load-sensitive race, but it could also be a
  real rare engine defect. Owed to the owner: replay it under load, and if it recurs write the failing test first.
  The earlier gate's PG 18 vs 16 read-plans Sort failure did not recur on this run; it stays owed on PG 16 via Docker.

**Panel build:** passes; the built CSS carries `--line-strong:#778898` and `--text-faint:#899cad`.
**Playwright e2e** (axe on every route and the network policy), Chromium only, repo specs through a temporary in-package
config pointing at the installed chromium 1248 (the pinned Playwright wants 1234, not installed; the config is deleted):
**35 passed**, after the final token, form, table and CSS-split changes.
**`docs:check`:** passed (generated documents, 594 links, 99 command blocks, imports, config reference); the "documented
commands" step skipped (no database URL in that shell).
**Route sweep** (172 renders, both themes, 1440 and 390, errors and overflow): 0 problems; two renders compared by eye
with the boards. No pixel diff (the boards cannot be rendered here).

**Review** (`code-review` skill): fixed with a failing test first where it was behaviour: `Field` labels a `Textarea`
and merges `aria-describedby`; `TableScroll` is a tab stop; `--row-bg` instead of `--bg`; the two narrowed contrast checks
restored by changing the tokens (R22); `markHits` is a literal case-insensitive RegExp; `SelectedEvent` has a test;
`index.css` split into `tokens.css` (R23). Accepted: untokenised `rounded-[…px]` values (finding 13). `security-review` not
run: auth, secrets, outbound requests and SQL are untouched (`shared/` and `src/lib/auth/` diffs empty).

**Not run:** Firefox and WebKit e2e; Docker-backed and emulator suites (ElasticMQ, Pub/Sub, PgBouncer, TLS Postgres,
PG 16), deferred by standing instruction; the `docs:check` documented commands. Task 01 stays `blocked` for the owner's
font approval. Known: `flow-page-reads.test.tsx` is order-dependent (at HEAD).
