# 04 — Guards and cost notes

**Status:** done · **Depends on:** 00 · **Touches:** `packages/transport-gcp` or `packages/transports`, `docs/limits.md`, `infra/gcp/README.md`

## Goal
Close the three cheap gaps that need no infra change.

## Steps
1. Test first: `openTransport` for `gcp-pubsub` refuses when `PUBSUB_EMULATOR_HOST` is set and no emulator host was configured on purpose. Then add the guard.
2. Add a note to `docs/limits.md` on the cost of one filtered subscription per queue, with the figure marked unverified until the pricing page is read.
3. Say in `infra/gcp/README.md` what grace Cloud Run gives a worker on SIGTERM, once confirmed from Google's docs.

## Acceptance
- A test shows the refusal and the explicit emulator path still works.
- The two notes name their source and say what was not verified.

## Verify
```bash
bun test packages/transports packages/transport-gcp
bun run typecheck && bun run lint && bun run format:check && bun run architecture && bun test
```

## Risks / notes
The guard changes behaviour for anyone who relies on the env variable alone; the contract and scenario suites use the explicit option.

## Result

Done 2026-10-17.

- **F8 guard.** `new PubSubTransport(...)` throws a `TransportError` when `PUBSUB_EMULATOR_HOST` is set, no `client` is
  given and no `emulatorHost` was passed. Tests: `packages/transport-gcp/test/emulatorGuard.test.ts` (3, written before the
  guard). **Behaviour change:** an emulator reached only through the environment variable no longer works through
  `openTransport`; pass `emulatorHost`. The contract and scenario suites already did.
- **F7 note.** `docs/limits.md` s11 now says, from Google's subscription-filter docs, that filtered-out messages still incur
  delivery fees, so the per-bell cost grows with the number of queues. No price is quoted; the pricing page was not read.
- **F10 note.** `docs/limits.md` s6 and `infra/gcp/README.md`: Cloud Run gives a worker pool a fixed 10 s after SIGTERM,
  less than the SDK's 20 s `close()` default (confirmed from Google's docs, not from a deployed pool).

**Ran:** the guard's tests and the whole suite; see the completion note for the gate.
**Did not run:** a real Pub/Sub client with a leaked variable.
