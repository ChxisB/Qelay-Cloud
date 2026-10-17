# 10 — Core types, state machine, interfaces

**Status:** done · **Depends on:** 06 · **Phase:** 1

## Goal

Create `packages/core`: the shared vocabulary and the two seams (`StateStore`, `DeliveryTransport`) that keep the SDK, Control
API, maintenance tick and tests independent of Postgres and of any cloud.

## Scope

In: job and queue types, the job state machine, option and error types, and the interface definitions as settled by task 06.
Out: any implementation. `core` has no runtime dependencies and imports nothing from `pg`, Bun SQL or a cloud SDK.

## Reference

`../qelay/src/domain/types/` and `../qelay/src/client/types/` (job, options, worker, events, DLQ, stall). Start from
these; drop anything tied to the TCP protocol, broker, SQLite or the `Qelay` high-level class (D6).

## Gate decisions (task 06)

Binding. Evidence: [docs/spikes/06-phase0-gate.md](../../../docs/spikes/06-phase0-gate.md); the sketch is DESIGN.md section 5.
The interfaces are **settled**: write them down as specified, and record any change in this task's Result and as an
amendment to the gate document rather than editing them quietly.

- **`DeliveryTransport`:** `Bell { namespace, queue, jobId? }` (`jobId` is a hint, never a claim); `RingItem { bell,
  deliverAfterMs? }` (relative, rounded up, never down); `ring(items)` returns one `RingResult` per item, in order
  (`ok`, or `delay-too-long` / `rejected` / `unreachable`); `Delivery { bell | null, attempt | null, ack(),
  nack(retryInMs?) }`; `capabilities { maxDeliverDelayMs, maxRingBatch, attemptCount, retryGranularityMs }` (no
  `ordering`); `subscribe(queue, handler, { capacity })` returning `{ refresh, close }` (demand-driven); `stats(queue)`
  with `source`, `observedAt`, `maxStalenessMs` and nullable counts; `close()`.
- **One cloud queue per Qelay queue.** `subscribe` and `stats` take the queue; `ring` routes by `bell.queue`.
- **`StateStore`:** an injected `Clock` (default: the database clock) and no `now` argument anywhere. Every mutation
  that makes a job claimable returns the rings to ring, each with `dueInMs` measured on the database clock at the
  call. `markRung` takes one entry per bell and sets `rung_at` only where the job is still claimable. `claim` does
  not count an attempt. `tick(budget)` returns `moreWork` and is safe to run concurrently with itself. Randomness
  (backoff jitter) and the job-id generator (UUIDv7) are injectable.
- **Operation deadline:** a store call that hits its deadline throws `OperationDeadlineError`, whose contract is
  "outcome unknown". Document on every write that it is guarded by lease token or `version`, so the caller may retry
  or drop it without a double effect.
- Task 02's provisional interface in `test/model/store.ts` is replaced by the one from this package, including the
  `Clock`.

## Steps

1. **Job model:** `JobRecord`, `NewJob`, `JobOptions`, `JobState` (`waiting`, `prioritized`, `delayed`, `waiting-children`, `active`, `completed`, `failed`), `Lease`, `ClaimedJob`.
2. **State machine** as data plus a pure `assertTransition(from, to)`: the legal-transition table from task 02, used by the store, the model harness and the Control API.
3. **Interfaces** from DESIGN.md section 5, updated by task 06: `StateStore` (enqueue, claim, heartbeat, complete, fail, tick, reads, operator actions) and
   `DeliveryTransport` (`capabilities`, `ring`, `subscribe`, `stats` including data freshness, `close`). Document each method's idempotency and failure contract in TSDoc.
4. **Options mapping:** the supported subset of Qelay job and worker options (D6), with an explicit `UnsupportedOptionError` for anything outside it so nothing is silently ignored.
5. **Errors:** typed errors (`LeaseLostError`, `JobNotFoundError`, `QueuePausedError`, `UnsupportedOptionError`, `TransportError`, `StoreError`, `OperationDeadlineError`) with stable `code` strings.
6. **Codec interface** (`encode`/`decode`) with the msgpackr implementation living in `store-postgres`.
7. Export everything from `src/index.ts`. Add unit tests for the transition table and option validation.

## Acceptance

- `core` builds with no runtime dependencies (`package.json` `dependencies` is empty).
- Every legal and illegal transition is covered by a test; the table matches the model harness (task 02) exactly.
- Both interfaces have TSDoc stating idempotency, ordering and error behaviour per method.
- The task 02 harness compiles against `StateStore` from this package, driving time through its `Clock`.
- Both interfaces match DESIGN.md section 5 (checked by a type-level test against the gate's `RingItem`, `Delivery` and `Clock` shapes).

## Verify

```bash
bun run typecheck && bun run lint && bun run format:check && bun run architecture
bun test packages/core
```

## Risks / notes

- Interface churn is expensive later. If task 06 left an open question about a method, resolve it here rather than leaving a TODO.
- Keep `core` small. Anything with an I/O dependency belongs in another package.

## Result

Done locally on 2026-10-14. `packages/core` exists with no runtime dependencies (`dependencies` is absent) and the task
02 harness now compiles against its `StateStore` and reads its transition table.

**What was built** (`packages/core/src/`)

| File | Contents |
|------|----------|
| `jobs.ts` | `JobState`, `Bell`, `Ring`, `RungEntry`, `JobOptions` (upstream names), `NewJob`, `EnqueuedJob`, `Lease`, `ClaimedJob`, `JobRecord`, `DlqEntry`, `FailureInfo`, `Outcome`, `TickBudget`, `TickReport`, `StateCounts`, `JobQuery`, `Page` |
| `transitions.ts` | `TRANSITIONS` as data, `allows`, `isLegalMove`, `assertTransition`, `isClaimable`, `isTerminal` |
| `store.ts` | `StateStore` with TSDoc per method (idempotency, deadline contract, who rings) |
| `transport.ts` | `DeliveryTransport`, `RingItem`, `RingResult`, `Delivery`, `TransportCapabilities`, `TransportStats`, `Subscription` |
| `errors.ts` | seven typed errors with stable `code` strings, plus `IllegalTransitionError` |
| `options.ts` | `validateJobOptions`: the D6 subset, `UnsupportedOptionError` for anything else |
| `clock.ts` | `Clock`, `Random`, `IdGenerator` seams |
| `codec.ts` | `Codec` interface (the msgpackr implementation stays in `store-postgres`, task 11) |

**Harness.** `test/model/store.ts` no longer defines a store contract: it re-exports core's types and keeps only
`StoreEnv` and `StoreFactory`. `model.ts` imports `TRANSITIONS`, `allows` and `isLegalMove` from core, so the harness and
the store cannot drift (the acceptance's "table matches the harness exactly" is true by construction, not by a copy
check). The fake store now returns rings with `dueInMs` from `enqueue`, sets `rung_at` only in `markRung`, takes a
`TickBudget`, and clears `rung_at` on `resume`. `World.ring()` does what the SDK will do: ring the items inside the
transport's delay window, apply the fault, then `markRung` every bell the broker took (a dropped bell was taken and then
lost, which is the case the tick repairs). The fake was split (`fakeRows.ts`) to stay under 300 lines.

**Differences from the DESIGN.md sketch** (none contradicts the gate; recorded in the gate write-up's "Amendments"):

1. `EnqueuedJob` carries `ring: Ring | null`; the named type is `Ring { bell, dueInMs }`.
2. `NewJob` is `{ queue, data, name?, options? }`. `JobOptions` uses **upstream's names** (`deduplication`, `group`,
   `stallTimeout`, boolean `removeOnComplete`/`removeOnFail`). My first draft invented `dedupKey`, `groupId` and `ttl`;
   they were checked against `../qelay/src/client/types/options.ts` and replaced before any caller existed.
3. `TickBudget { maxDurationMs, maxRingsPerQueue, maxItems }` and `TickReport { recovered, promoted, cronFired, expired,
   rings, moreWork }` are concrete here; the gate fixed only "`tick(budget)` returns `moreWork`". Task 15 may add fields.
4. `StateStore.close({ timeout })` and `subscribe` returning a named `Subscription`.
5. `Random` and `IdGenerator` are named seams next to `Clock`, as the gate requires them injectable.

**Verified**

- `bun test packages/core`: 16 pass, 0 fail. This includes every `(cause, from, to)` triple (legal accepted, all others
  refused with `IllegalTransitionError`), the supported and refused options, and type-level assertions against the
  gate's `Bell`, `RingItem`, `RingResult`, `Delivery`, `TransportCapabilities`, `TransportStats` and `Clock` shapes,
  plus a check that no `StateStore` method takes a `now`.
- `bun run test:model`: 6 pass, 0 fail, including the five planted-bug targets, on core's `StateStore`.
- `bun run typecheck`, `lint`, `format:check` and `architecture` (155 TypeScript files, all within 300 lines): clean.
- `QCLOUD_REQUIRE_DB=1 bun test` (Postgres, PgBouncer, TLS Postgres, ElasticMQ and the Pub/Sub emulator reachable): 104
  pass, 0 fail, 21 files, 191 s.

**Not done / not verified**

- The harness has still only run against the in-memory fake (condition 1 of the go). The Postgres store with the clock
  seam is task 11 onwards.
- `resume` clearing `rung_at` is a contract in TSDoc and in the fake; no Postgres code implements it yet (task 13).
- `Codec` has no implementation or round-trip test here; that lands with `store-postgres` (task 11/12).
