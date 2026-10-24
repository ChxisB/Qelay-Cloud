# 12 — Queue retry policy

**Status:** done · **Depends on:** 11 · **Touches:** packages/store-postgres (enqueue), packages/control-api, packages/sdk, docs
**Design:** none (reuses existing pages and parts)

## Goal
A queue can carry default attempts, backoff (with a cap) and timeout that every job without its own gets.

## Steps
1. Read enqueue.ts first: where the job's options are fixed, and whether queue_state is read there already. Apply the policy at enqueue (the job row stores the resolved options), never on the claim or fail path.
2. Routes: GET and PUT /queues/{queue}/policy (operator, audited). Bounds from core validateJobOptions.
3. SDK `queue.setPolicy()` and `getPolicy()`.
4. A job's own option always wins; the policy applies to jobs added after it is saved.

## Acceptance
- A job added with no attempts on a queue with policy attempts 5 and exponential 10 s / cap 600 s stores those; a job with its own attempts keeps them.
- Enqueue cost: a queue with no policy adds no query (a statement-count test).
- Invalid policies are 400 naming the field; openapi and security:routes pass.

## Verify
```bash
QCLOUD_REQUIRE_DB=1 bun test packages/store-postgres packages/control-api packages/sdk
```

## Result
Done. A queue policy `{attempts, backoff, timeout}` is stored in `qcloud_queue_state.policy` (migration 23) and applied at enqueue.

**What changed**
- `core/queuePolicy.ts`: `QueuePolicy` and `validateQueuePolicy`. It reuses `validateJobOptions` for every bound, so a bad field is `UnsupportedOptionError` naming it (`attempts`, `backoff.type`, `backoff.delay`, and so on). `{}` is valid and means none. A number backoff is stored as `{type:'fixed', delay}`.
- `store-postgres/store/queuePolicy.ts`: `getQueuePolicy`, `setQueuePolicy` (locks the state row exclusively like the other settings, creates it if the queue was never used; `null` and `{}` store NULL), `registerQueues` (now returns the policies) and `applyPolicies`. `store.queues.policy()` and `store.queues.setPolicy()` in `facets.ts`.
- `PreparedJob` gained `envelope` and `own` (which of the three settings the job set itself). The policy fills only what the job left out, so a job's own option always wins, each setting on its own. The backoff lives only inside the payload, so a job that takes the policy backoff is encoded again, and the payload size limit is checked again (`PayloadTooLargeError`).
- `store-postgres/store/enqueue.ts`: `planAndWrite` registers the queues first, in the one statement that also reads their policies, then applies them and plans. Every enqueue path goes through it: `enqueue`, flow children and parents, cron firings.
- Control API: `GET` and `PUT /queues/{queue}/policy` (`PUT` is operator-only and audited as `policy <keys>` or `policy removed`). `PUT` replaces the whole policy and `{}` removes it. `docs/openapi.yaml`, `docs/reference/routes.md`, `docs/security/routes.md` (regenerated with `--write`) and the control-api README are updated.
- SDK: `Queue.setPolicy()` and `Queue.getPolicy()`; `QueuePolicy` is exported; `docs/compat.md` lists them as New.

**Deviations from the plan**
- "Backoff with cap and jitter": the cap is the existing `maxDelay`. Jitter is the store-wide `jitter` option, not per queue or per job, so a policy that names `backoff.jitter` is refused with a message saying so rather than stored and ignored. A per-queue jitter would need a read on the fail path, which D17 rules out.
- Registration moved from after the plan to before it (the old call ran only when a job was inserted). A batch of nothing but duplicates now also registers its queues; those already exist, so nothing changes.

**Enqueue cost.** Measured on the code before this task: 5 statements for a one-job enqueue. After: 5, with and without a policy (`queue.policy.test.ts`, via `test/statementCount.ts`). The policy read rides on the registration statement.

**What ran** (local Postgres 18, `QCLOUD_REQUIRE_DB=1`): `bun test packages/store-postgres packages/control-api packages/sdk packages/core` gave 3118 pass, 22 skip, 1 fail on the first run. The fail was `security.routes.test.ts` because I had written `docs/security/routes.md` by hand; after `bun run security:routes --write` it passes (5 tests), and `--check` and `bun run docs:check` pass. Typecheck, lint (no errors; the panel warnings were there before), `format:check` and `architecture` pass. The skips are the PgBouncer, TLS, Pub/Sub and SQS suites, which need services that are not running here.

**Not run:** the full `bun test` after the fix (only the failing file and `docs:check` were rerun), `bun run test:model` (nothing in the claim or fail path changed), the panel (task 14).

