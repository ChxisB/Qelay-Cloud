# Task 70 plan: documentation

Read `.claude/.planning/v1.0.0/70-docs.md` first. Docker is deferred (user instruction), so Compose commands are marked
`bash notrun` and the same commands run on a host Postgres through the doc runner.

## Stages

- [ ] A. Tooling (`scripts/docs/*`, `scripts/check-docs.ts`, tests in `test/docs/`): markdown parser, link and anchor
      checker, `bash test` runner, generators (`docs/unsupported.md`, `docs/reference/sdk-exports.md`,
      `docs/reference/routes.md`), env-var coverage, package-name check, `docs:check` script, CI step.
- [ ] B. Fix drift found on the way: `@qelay-cloud/sdk` is not a package (D10: the SDK is `qelay-cloud`) in
      `docs/compat.md` and `packages/sdk/src/workflow/index.ts`; DESIGN.md line on QueueEvents connections (spike 06
      task-19 finding (e)); `examples/orders/README.md` says no Dockerfile exists.
- [ ] C. Docs: README, quickstart-local/gcp/aws, concepts, migration, reference (configuration, control-api, tick, sdk),
      operations, architecture, CONTRIBUTING.
- [ ] D. Run `bun run docs:check` with Postgres up; run every `bash test` block; Verify commands; full gate.
- [ ] E. Close: task file Result and Status, CURRENT.md row 70 and "Progress: 39 of 42", completion doc
      `.claude/completions/2026-10-16-70-docs.md`, spike amendment, archive this file.

## Decisions so far

- `docs/migration.md` is the file name `docs/compat.md` already links to.
- A `bash` fence in a quickstart is either `bash test` (the runner executes it) or `bash notrun` with a `> Not run:`
  line since the previous heading saying why. A plain `bash` fence in a quickstart fails the check.
- The runner makes a throwaway database on the test server (`QCLOUD_TEST_DATABASE_URL`) and gives the blocks its URL
  as `QCLOUD_DATABASE_URL`; ports 8080 (API) and 8081 (panel) must be free.
