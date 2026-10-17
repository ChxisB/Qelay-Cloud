# 70 — Documentation

**Status:** done locally · **Depends on:** 43, 51, 52 · **Phase:** 6

## Goal

Documentation a new user can follow from nothing to a running deployment on either cloud, and a maintainer can use to understand why the system is built this way.

## Scope

In: README, quickstart, concepts, migration guide from Qelay, API and configuration reference, architecture, transports, limits, contributing.
Out: marketing material, a documentation website (plain Markdown in the repo is enough for v1.0.0).

## Steps

1. **README:** what it is and is not (no queue server; Postgres is the source of truth; doorbells), a one-screen quickstart on the local transport, a feature list matching `docs/compat.md`, links.
2. **Quickstart guides:** local (Docker Compose); GCP (Terraform from `infra/gcp`, deploy, first job); AWS (the same). Each finishes with "see your job in the panel". Test every command in a clean checkout and fix what breaks.
3. **Concepts:** the doorbell model and the five invariants; the lease and its token; the maintenance tick and why it exists; delay precision per transport; why flows live in Postgres. Reuse and trim DESIGN.md rather than rewriting it; link to it for the full reasoning.
4. **Migration guide from Qelay:** import and connection changes, the compat table (`docs/compat.md`), unsupported options and the errors you will see, data migration (state it plainly: v1.0.0 does not migrate jobs from a running Qelay server; drain first).
5. **Reference:** SDK API (generated from TSDoc where possible), Control API (`docs/openapi.yaml` rendered or linked), configuration and environment variables, capabilities, the audit log, the tick report.
6. **Operations:** point to the runbooks from task 71; sizing guidance from the load results (task 22); the connection budget formula (task 05).
7. **Architecture and contributing:** package layout, the gate commands, the porting rules and `docs/PORTING.md`, how to add a transport (the contract suite is the spec), how to run the model tests.
8. **Doc checks in CI:** link checker, a script that runs the code blocks marked `bash test` in the quickstarts against the local stack, and the compat and transport tables generated rather than hand-copied where possible.

## Acceptance

- A person who has not seen the project can follow the local quickstart and have a job running in the panel in under 15 minutes (ask the user to try it, or run it in a clean container).
- Every command in the quickstarts has been executed at least once; the cloud ones are marked "not run against a real account" unless D9 allowed it.
- The migration guide lists every unsupported Qelay feature the compat table lists.
- CI fails on a broken link or a failing documented command.

## Verify

```bash
bun run docs:check            # link check + doc command runner, defined by this task
bun run typecheck && bun run lint && bun run format:check
```

## Risks / notes

- Docs drift fastest where they restate code. Generate tables and references from the source where you can.
- Do not document a behaviour that was only tested on an emulator as if it were proven on the real service.

## Result

**Done locally (2026-10-17), on PostgreSQL 18.6.** Nothing was applied, pushed or published; no real cloud, no Docker, no clean container.
Completion record: [.claude/completions/2026-10-17-70-docs.md](../../completions/2026-10-17-70-docs.md).

What exists:

- **Pages:** [README](../../../README.md); `docs/quickstart-local.md`, `quickstart-gcp.md`, `quickstart-aws.md`; `docs/concepts.md`; `docs/migration.md`;
  `docs/operations.md`; `docs/architecture.md`; [CONTRIBUTING.md](../../../CONTRIBUTING.md); `docs/reference/configuration.md`. Existing `compat.md`, `limits.md`,
  `transports.md`, `webhooks.md`, `runbooks/` and `openapi.yaml` are linked, not restated.
- **Generated, not copied:** `docs/unsupported.md` (from `compat.md`: 55 not-supported rows), `docs/reference/sdk-exports.md` (from the SDK entry point) and
  `docs/reference/routes.md` (from `openapi.yaml`), plus the existing `docs/transports.md`. `bun run docs:check --write` rewrites them.
- **`bun run docs:check`** (`scripts/check-docs.ts`, `scripts/docs/*`, CI step "Documentation"): generated documents current; every relative link and `#fragment`
  resolves (436 links, 33 files; 28 external links counted, not followed); a quickstart command block is `bash test` or `bash notrun` with a `> Not run:` reason (76
  blocks); a TypeScript block imports only packages that exist (the SDK is `qelay-cloud`); the configuration reference lists exactly the `QCLOUD_*` variables the
  production code reads, both ways; every `bash test` block runs in order, in one shell with a minimal environment, against a throwaway database.
- **Drift fixed on the way:** `@qelay-cloud/sdk` (not a package; D10) in `compat.md` and `packages/sdk/src/workflow/index.ts`; DESIGN.md's claim that each
  `QueueEvents` adds a direct connection (spike 06 task 19 finding (e), now marked amended); `examples/orders/README.md` (it said no Dockerfile existed).

Acceptance:

- *A newcomer has a job in the panel in under 15 minutes:* **not shown.** The local quickstart's seven runnable blocks run end to end in 9 to 11 s (migrate, worker, API,
  five orders and a failing charge into the dead-letter queue, panel build and serve) in this checkout. Nobody has followed it from a clean machine, and the
  Compose step (`docker compose -f examples/orders/docker-compose.yml`) is `bash notrun` because Docker is deferred. The 15-minute claim needs the user to try it.
- *Every quickstart command was executed once:* the local ones, yes (`bash test`). The GCP and AWS ones are `bash notrun`, each with its reason, and both pages say
  in their first lines that nothing was applied to a real project or account (D9 not given).
- *The migration guide lists every unsupported Qelay feature:* by link. It gives the first-things-to-change list and "What will not move" and links
  `docs/unsupported.md`, which is generated from `compat.md` and checked current, so it cannot lose a row. The 55 rows are not inlined in the guide.
- *CI fails on a broken link or a failing documented command:* the `Documentation` step of the `test` job runs `docs:check` with `QCLOUD_REQUIRE_DB=1`. That step has
  **never run on GitHub**. `test/docs/checker.test.ts` (12 tests) shows the checker failing on a dead link, a dead anchor, an absolute and an out-of-tree link, an
  unchecked quickstart command, a bad fence flag, a missing package and a deep import, an undocumented and a stale variable, and a failing command (it names the
  block). The runner also keeps the developer's environment out of a block.

Run: `bun run typecheck`, `lint` (warnings only, all in `packages/panel`, none new), `format:check`, `architecture` clean; `bun run docs:check` passes (7 blocks run);
`bun test test/docs` 17 pass. Full `bun test` with Postgres 18, the Pub/Sub emulator and ElasticMQ required (`QCLOUD_REQUIRE_DB`, `_SQS`, `_PUBSUB`): 4,918 pass, 29 skip
(Docker-only suites), 1 todo, 0 fail, in 1,003 s. That run started before `checker.test.ts` was added, so its 12 tests are counted only in the `test/docs` run.

Owed: a person following the local quickstart from a clean checkout or container (the 15-minute claim); the Docker-backed gate; the first GitHub run of the
`Documentation` step; real-cloud runs of the GCP and AWS quickstarts (D9). The figures in `operations.md` are derived from the code or measured on a local Postgres and
an emulator, and its first lines say so; the alarm thresholds it quotes are defaults, unproven against real load.
