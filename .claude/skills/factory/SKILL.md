---
name: factory
description: Run a feature, bug fix or change through Qelay-Cloud's plan, build, verify and hand-off pipeline. Plans it as small ordered mini-tasks under .claude/.planning/<slug>/, builds each with its tests, runs the gate and a review, then writes the completion doc. Use for "/factory <request>" and for any feature or bug that is not already a task in v1.0.0/CURRENT.md.
argument-hint: <feature, bug or ticket>
disable-model-invocation: true
---

# Factory

Request: $ARGUMENTS

You orchestrate one request through six phases. [CLAUDE.md](../../../CLAUDE.md) is the source of truth for the rules,
the gate and the test services; this file adds the process and does not repeat them. Tasks already in
[v1.0.0/CURRENT.md](../../.planning/v1.0.0/CURRENT.md) are worked from their own files, not re-planned here.

## Operating rules

1. **No validation is skipped.** Nothing is done until the gate in CLAUDE.md ran and passed. Work that touches the store
   runs with Postgres up and `QCLOUD_REQUIRE_DB=1`.
2. **Match what is there.** Read the neighbouring code and tests first. Files stay under 300 lines, English only,
   `qcloud_*` tables, `Bun.SQL`. Ported code gets the MIT notice and a row in `docs/PORTING.md`.
3. **Isolate the change.** Touch only what the current mini-task names. Never read, edit or print `.env*`, `*.key`,
   `*.pem`, `*.tfvars`, `*.tfstate` or anything holding a secret. `../qelay` and `../qelay-control-panel` are read-only.
4. **Say what ran, against what.** "Passed on local PG 18", "emulator only", "not run". Never claim a run that did not
   happen, and never loosen a test to make it pass.
5. **Stop and ask** (a human gate) before any of these:
   - the design is wrong or a decision in DESIGN.md (D1 to D9) has to change: record it, do not deviate silently;
   - a new migration, a change to the `StateStore` or `DeliveryTransport` interfaces, a new public route in
     `docs/openapi.yaml`, a new dependency, anything under `infra/`, anything about auth or roles, or removing or renaming
     what the previous release reads or writes;
   - `terraform apply` or `destroy`, `gcloud` or `aws` writes, anything paid or shared (D9);
   - push, publish or a version bump;
   - a mini-task that still fails its Acceptance after two honest attempts.

## Phase 0: Intake (read-only)

Read CLAUDE.md, the parts of DESIGN.md and `docs/limits.md` the request touches, the affected packages and their tests,
and `git status`. A bug starts by reproducing it. Pick a short kebab-case slug (`webhook-replay`). If
`.claude/.planning/<slug>/` already exists, resume from its `CURRENT.md` instead of starting again.

## Phase 1: Specification

Write `.claude/.planning/<slug>/CURRENT.md`:

- **Goal**, **Scope in / out**, and **Touches** (packages, migration, openapi, infra, panel, docs).
- **Design impact:** does it fit DESIGN.md? If not, stop (gate above).
- **Risks**, and the **Status** table (below) once Phase 2 has split the work.

Give the user a five-line summary. Continue on your own unless the request hits a human gate; then ask and wait.

## Phase 2: Split into mini-tasks

Write one file per mini-task, `.claude/.planning/<slug>/NN-short-name.md`, and list them in the status table:

| # | Mini-task | Depends on | Status |
|---|-----------|-----------|--------|

Statuses are `todo`, `doing`, `done`, `blocked`. How to split:

- One slice is one reviewable change that ends with passing tests. If it needs more than a handful of files, split it.
- Order by dependency: types and interfaces, store and migration, logic, Control API and openapi, panel, docs.
- Tests belong to the task they test. There is no "write tests" task at the end.
- A migration is its own mini-task. A bug fix starts with a mini-task that is the failing test.

Mini-task file:

````markdown
# NN — Title

**Status:** todo · **Depends on:** NN · **Touches:** packages/…

## Goal
One sentence.

## Steps
1. …

## Acceptance
- Statements that are true or false. Each one has a test or a command that shows it.

## Verify
```bash
bun test packages/…
```

## Risks / notes

## Result
Empty until done: what changed, what ran and against what, what did not run.
````

## Phase 3: Build

For each mini-task in order: set it `doing`; write the test and the code together (for a bug, see the test fail for the
right reason first); run its Verify commands and `bun run typecheck`; fill **Result**; set it `done`. If a step of the
plan is wrong, fix the plan file and say so. If the design is wrong, that is a gate. Independent mini-tasks may go to a
subagent when one is available, and you still check each Acceptance yourself.

## Phase 4: Verify and review

Run the full gate from CLAUDE.md. Then add what the change calls for:

| Change | Also run |
|--------|----------|
| Core queue semantics | `bun run test:model` |
| Schema | regenerate `schema.snapshot.txt` (`QCLOUD_UPDATE_SNAPSHOT=1`) and review its diff; a row in `schema.indexes.test.ts` for a new query path |
| A transport or capability | `bun run docs:transports`, `bun run test:contract` |
| Anything under `infra/` | `bun run check:terraform` |
| Routes | the openapi test: `docs/openapi.yaml` and the served routes must match |
| Docs | `bun run docs:check` |

Then review the diff with the `code-review` skill, and also `security-review` when the change touches auth, secrets,
outbound requests or SQL built from input. Fix what they find, then run the gate again.

## Phase 5: Hand-off

1. Mark the spec's status table and write `.claude/completions/YYYY-MM-DD-<slug>.md`: changed files, what was checked,
   what is owed or not run.
2. Reply with what changed, the gate result as it was (pass, or the failing output), the risks, the not-run list and
   what needs the user's sign-off. Do not commit, push or publish unless asked.
