# Task 00: repo bootstrap and quality gate (2026-10-13)

**Done**: `Qelay-Cloud/` is now a git repository (`main`, nothing committed) and a Bun workspace with eight stub
packages, strict TypeScript project references, Oxlint/Oxfmt, the 300-line check, a throwaway Postgres 16 for tests
(`docker-compose.test.yml`, port 55432), an isolated-schema test helper, a CI skeleton, repo `CLAUDE.md`, `LICENSE` and
`docs/PORTING.md`. Full detail and the list of deviations are in the Result section of
`.claude/.planning/v1.0.0/00-repo-bootstrap.md`.

**Checked**: the gate (`typecheck`, `lint`, `format:check`, `architecture`, `test`) exits 0 from a fresh
`node_modules` with the test DB up and `QCLOUD_REQUIRE_DB=1`. `bun run --filter '*' typecheck` passes for 8 of 8
packages. Typecheck, lint and the file-size check were each shown to fail on a planted violation. The helper's schemas
are isolated and nothing is left behind after `drop()`.

**Not done / not verified**: the CI workflow has never run (needs GitHub). Nothing committed or pushed. No cloud
resources touched. The Postgres image was pulled locally.

**Open for the user**: database suites skip with a warning when Postgres is down unless `QCLOUD_REQUIRE_DB=1`. That was
needed so plain `bun test` passes before the container starts, but it means store tasks (11 onwards) must run their
gate with the variable set. It is in `CLAUDE.md`. Also decide when to make the first commit: `.claude/` (the plan) is
untracked and will be included.

**Next**: tasks 01 (port inventory and broker coupling) and 02 (StateStore model-test harness), which can run together.
