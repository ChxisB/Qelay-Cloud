# Task 33: Panel, clone and baseline (2026-10-15)

**Done locally. No cloud resource was touched.** The panel ran only against its own demo-mode fixtures: no Control API was
started for it and no Playwright spec ran against a live backend. Everything else ran on the local PostgreSQL 18.6, not the
Docker PG 16 of CI.

**Changed files**

- `packages/panel/` (new, 588 files): `src/`, `shared/flowOperationPolicy.ts`, `test/` (193 suites), `e2e/` (5 spec files),
  `public/`, `patches/ai@7.0.14.patch`, `index.html`, `vite.config.ts`, three tsconfigs, `playwright.config.ts`,
  `package.json`, `README.md` (new), `LICENSE` (upstream, unchanged).
- Changed from the upstream commit: `package.json`, `index.html`, `vite.config.ts`, `src/components/layout/pageTitle.ts`,
  `src/lib/copilot/runtime.ts`, `tsconfig.e2e.json`, `playwright.config.ts`, `e2e/*.e2e.ts`, `e2e/fixtures.ts`,
  `test/bq.helpers.ts`, `test/legacy-name-guard.test.ts`, `test/brand-copy-guard.test.ts`,
  `test/frontend-a11y-fixes.test.ts`. The full list with reasons is in `docs/PORTING.md`.
- Root: `package.json` (`typecheck`, `patchedDependencies`), `bunfig.toml` (test preload), `.oxlintrc.json` (override for
  `packages/panel/**`), `.oxfmtrc.json`, `.gitignore`, `bun.lock`.
- `docs/PORTING.md` (section "Panel (task 33)": provenance, left out, changed, suites removed, feature triage, e2e).
- Task file (Result, status), `CURRENT.md` (row 33, 24 of 42).

**Checked**

- `bun install` clean; `bun run typecheck && bun run lint && bun run format:check && bun run architecture`: exit 0 each
  (lint reports the 120 panel warnings below).
- `bun test packages/panel`: 1,066 pass, 0 fail (193 files, 48 s).
- `bun run --cwd packages/panel build`: passes, `dist` 1.3 MB.
- `dev:stub` served on :5273; a headless Chromium rendered 13 routes with zero console or page errors.
- `QCLOUD_REQUIRE_DB=1 bun test` (all packages): 3,236 pass, 114 skip, 0 fail, no unhandled errors (371 files, 354 s). The skips are the Docker-backed
  suites (PgBouncer, TLS, ElasticMQ, Pub/Sub emulator).
- `bun run test:model` not run: no queue semantics changed.

**Measured**

- Upstream 257 test files; 193 kept, 64 removed (each imports `agent/`, or tests scripts, release tooling, the docs site or
  the upstream's own Oxlint fixtures, none of which is carried). 0 assertions weakened.
- Lint: 120 findings from five React-compiler rules, which the upstream's older locked Oxlint did not have.

**Decisions**

- The copy is of the committed upstream `HEAD` (`8ebf9328…`) via `git archive`. The upstream working tree had 385 modified and
  about 25 untracked files that are not here (commit them upstream and copy again to use them).
- The agent is not carried; queue-operations, backups and fleet are kept and hidden by capability in task 34; flows are task
  51, workflows task 62.
- The five React-compiler lint rules are warnings for `packages/panel/**` only, rather than editing 120 component sites in a
  baseline task or turning the rules off for the repository.
- The four `@ai-sdk/*` adapters are pinned to upstream-lock versions (a second `@ai-sdk/provider` copy broke the types).
- The e2e specs are skipped as a whole with `LIVE_BACKEND_PENDING` rather than rewritten; their assertions are untouched.
- The panel's own social tags and canonical link are removed (the host is not known).

**Found and fixed**

- `test-inventory-gate` was missed in the first triage (it reads `agent/` and a script that is not carried). It showed up
  only as an "unhandled error between tests" in the full `bun test`, not in the panel run's pass/fail counts. Removed and
  listed.
- `legacy-name-guard` scanned removed directories; narrowed to the carried paths, licence assertions unchanged.
- `e2e/operations.e2e.ts` imported the `bunqueue` package's version; it uses a constant now.

**Owed**

- Task 34: Control API wiring (`/agent/*` routes, `confirm`, `expectedVersion`, `VITE_BUNQUEUE_*` names, hide-by-capability,
  footer and command-palette links, an e2e runtime and the removal of the skips).
- The 120 lint warnings.
- A run of the panel against the real Control API in a browser (nothing here exercises it).
