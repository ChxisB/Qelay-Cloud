# 00 — Repo bootstrap and quality gate

**Status:** done (2026-10-13) · **Depends on:** D5 · **Phase:** foundation

## Goal

Turn `Qelay-Cloud/` into a working Bun monorepo with a gate every later task can run. Nothing here is product code.

## Scope

In: git init, workspaces, tooling configs, the gate scripts, a local Postgres for tests, a CI skeleton, repo `CLAUDE.md`,
licence, `docs/PORTING.md`, empty package stubs.
Out: the `panel` package (task 33) and any queue logic.

## Steps

1. `git init`; add `.gitignore` (node_modules, dist, coverage, `.env*` except `.env.example`, terraform state and `.terraform/`).
2. Root `package.json` with Bun workspaces `packages/*`; `.bun-version` = `1.4.2` (same as the panel).
3. Root `tsconfig.json`: copy the strict flags from `../qelay-control-panel/tsconfig.json` (`strict`, `noUnusedLocals`,
   `noUnusedParameters`, `noFallthroughCasesInSwitch`, `isolatedModules`, `moduleResolution: bundler`) without `DOM`/`jsx`.
   One `tsconfig.json` per package extending it, with project references.
4. Copy `.oxlintrc.json` and `.oxfmtrc.json` from `../qelay-control-panel`; adjust only paths.
5. Copy `scripts/check-file-size.ts` (300-line limit) from the panel; wire as `bun run architecture`.
6. Root scripts: `typecheck`, `lint`, `format`, `format:check`, `architecture`, `test`, and placeholders `test:model` (task 02) and
   `test:contract` (task 41).
7. `docker-compose.test.yml`: Postgres 16 on a non-default port, tmpfs data, healthcheck. Test helper
   `test/support/db.ts` reads `QCLOUD_TEST_DATABASE_URL` (default points at that container) and creates an isolated schema per test file.
8. Package stubs with an empty `src/index.ts` and a `package.json` each: `core`, `store-postgres`, `transport-local`,
   `transport-gcp`, `transport-aws`, `sdk`, `maintenance`, `control-api`. Names per D10.
9. `.github/workflows/ci.yml`: install, then the gate, with a Postgres service container. No release or publish jobs yet.
10. Repo `CLAUDE.md`: English only; failing-test-first for bugs; the gate; the porting rule; the cloud-resources rule; no push without the user.
11. `LICENSE` per D5. `docs/PORTING.md` with the empty provenance table (upstream path, upstream commit, change).

## Acceptance

- `bun install && bun run typecheck && bun run lint && bun run format:check && bun run architecture && bun test` all pass on the empty packages.
- `docker compose -f docker-compose.test.yml up -d --wait` brings up Postgres, and a smoke test connects to it through the helper and creates and drops an isolated schema.
- Each package builds as a workspace member (`bun run --filter '*' typecheck` passes).
- `LICENSE` keeps Egeo Minotti's line and adds the fork line.

## Verify

```bash
bun install
bun run typecheck && bun run lint && bun run format:check && bun run architecture && bun test
docker compose -f docker-compose.test.yml up -d --wait && bun test test/support
git status --short   # only intended files
```

## Risks / notes

- Do not copy `node_modules`, build output, or the panel's `.bun-build` artifact when copying configs.
- Keep the test database on a non-default port so it never collides with a developer's local Postgres.
- The CI skeleton must not reference secrets or cloud credentials yet.

## Result

Done 2026-10-13. All four Acceptance items are true and every Verify command was run.

**What changed.** `git init -b main` (nothing committed). Bun workspace with `packages/*` and eight stub packages
(`qelay-cloud` for the SDK, `@qelay-cloud/*` for the rest, all `private: true`, `exports` pointing at `src/index.ts`).
Root `tsconfig.json` (strict flags from the panel, no `DOM`/`jsx`) with project references to every package, plus a
`tsconfig.tooling.json` for `scripts/` and `test/`. Oxlint and Oxfmt configs, `scripts/check-file-size.ts`,
`docker-compose.test.yml` (Postgres 16 on `127.0.0.1:55432`, tmpfs), `test/support/db.ts` plus a smoke test,
`.github/workflows/ci.yml`, repo `CLAUDE.md`, `LICENSE`, `docs/PORTING.md` (empty table, upstream commit `c43442c9`),
`bun.lock`.

**Measured.**

- Gate with the test DB up and `QCLOUD_REQUIRE_DB=1`, from a fresh `node_modules` and `bun install --frozen-lockfile`:
  `typecheck`, `lint`, `format:check`, `architecture`, `test` all exit 0. `bun test`: 3 pass, 0 fail.
- `bun run --filter '*' typecheck`: 8 of 8 packages exit 0. The root is not matched, so no recursion.
- Each gate step was shown to fail when it should: a planted type error, a `==` plus `debugger`, and a 302-line file
  each made `typecheck`, `lint` and `architecture` exit 1. The planted files were removed.
- The DB helper creates and drops isolated schemas. Tables in one schema are invisible in another, and a query for
  leftover `qcloud_t_*` schemas returned 0 afterwards.
- `git status --short` shows only intended files. Ignored: `node_modules/` and `*.tsbuildinfo`. Nothing is emitted to `dist`.

**Decisions and deviations (read these before task 01/02).**

1. **DB suites skip when Postgres is down, unless `QCLOUD_REQUIRE_DB=1`.** Acceptance and Verify run plain `bun test`
   before the container exists, so the smoke test cannot hard-fail there. A skip prints a warning. CI sets the
   variable, so it fails there instead. **Any task that touches the store must run the gate with the DB up and
   `QCLOUD_REQUIRE_DB=1`**, or its tests may be skipped without anyone noticing. This is in `CLAUDE.md`.
2. **`test:model` and `test:contract` placeholders exit 1**, not 0, so a command that verifies nothing never reports
   success. They are not part of the gate, so nothing else is affected.
3. **TypeScript 6 changed the `types` default to empty**, so the base config sets `"types": ["bun-types"]`.
   `composite` plus `noEmit` works under 6.0.3: `tsc -b` type-checks and writes only `.tsbuildinfo` (gitignored).
4. **`scripts/` and `test/` are typechecked** via `tsconfig.tooling.json`. The panel does not typecheck its scripts.
   Both remain excluded from Oxlint and Oxfmt, as upstream.
5. **`check-file-size.ts` skips `node_modules`, `dist`, `coverage` and `.terraform` by name at any depth.** Upstream only
   skipped root-level `dist` and `coverage`, which would have counted each package's emitted `.d.ts`.
6. **`.oxlintrc.json` keeps the `react` and `jsx-a11y` plugins and the browser env** from the panel, because task 33
   will need them. Only `ignorePatterns` was trimmed to paths that exist here.
7. **`LICENSE` is Qelay's verbatim** (Egeo Minotti 2024 line untouched, `ChxisB` 2026 fork line), with a short derivation
   note appended, like the panel's.
8. `.gitignore` also covers `.DS_Store`, `*.tsbuildinfo`, `*.tfvars`, `.claude/worktrees/` and
   `.claude/settings.local.json`, beyond the list in Steps.

**Not run or not verified.**

- **The CI workflow has never executed.** I can only run it on GitHub. Both YAML files parse and the workflow
  references no secrets, but treat it as untested until the first push.
- The Docker image `postgres:16-alpine` was pulled to this machine. No cloud resources were touched.
- Dependency versions were taken from the panel's ranges. Newer `oxfmt` (0.73.0) and `typescript` (7.0.2) exist and were
  deliberately not adopted.
- `.claude/` (this plan) shows as untracked and will be part of the first commit. Nothing was committed or pushed.
