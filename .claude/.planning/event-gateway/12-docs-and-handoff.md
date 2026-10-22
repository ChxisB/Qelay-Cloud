# 12 — Docs and hand-off

**Status:** done · **Depends on:** 11 · **Touches:** docs, DESIGN.md, packages/panel/README, DESIGN-MAP

## Goal
The docs say what the console and the gateway are now.

## Steps
1. New `docs/event-gateway.md` (routes, destinations, the save check for loops, the "no route, no effect" rule, worked example "when an
   order fails, refund it"). `docs/webhooks.md` becomes the reference for the `http` destination and links up to it.
2. `docs/concepts.md` "Flows and workflows": add the one-page-two-engines sentence and a pointer to Event gateway.
3. `docs/limits.md`: the chain cap (5) and the bulk-retry cap. `known-issues.md`: inbound sources are planned, not built (D12, `.claude/.planning/inbound-sources/`); Issues has no acknowledge, resolve or ignore state.
4. DESIGN.md D11 flips to Decided only if the owner says so. README and DESIGN-MAP for the nav (Home, Event gateway) and the gateway page.
5. Full gate with Postgres up, `bun run docs:check`, `bun run test:model`; completion note in `.claude/completions/`.

## Acceptance
- `bun run docs:check` passes; every link resolves.
- The final report lists what was and was not run.

## Verify
```bash
bun run typecheck && bun run lint && bun run format:check && bun run architecture && QCLOUD_REQUIRE_DB=1 bun test && bun run docs:check
```

## Result

**Docs.** New `docs/event-gateway.md` (the model, both destinations, the worked example "when an order fails, refund it",
"no route, no effect", loops refused on save, the panel's four tabs, the API, upgrading, not built). `docs/webhooks.md` and
`docs/concepts.md` point to it; `docs/limits.md` has the chain cap (5), the bulk-retry cap (500), the stats window (7 days)
and the stats read's cost; `docs/known-issues.md` rows 12 (D12 not built), 13 (Issues is read-only) and 14 (a queue route can
add its job twice); `README.md`, `packages/panel/README.md` and `DESIGN-MAP.md` carry the new navigation. `docs/reference/routes.md`
was regenerated. DESIGN.md D11 was already Decided by the owner; D12 stays Proposed.

**Review (`code-review`, 12 findings) and what was done:**
- Fixed, test first: a queue route was given a generated and sealed secret and reported `signed: true`. It now gets none, a
  given `secret` is refused, and rotating one is refused (`400 unsupported_option`); 3 new tests in `webhook.routes.test.ts`.
- Fixed: an event in flight read "Pending" in the row while the Pending chip hid it. A Sending chip and word were added.
- Fixed: Home polled the 24 h gateway stats on the global 3 s cadence; it now polls once a minute.
- Fixed: `schema.planned.webhook.ts` had no row for the all-routes feed with a time window (the Events default); it plans on the
  primary key, ordered.
- Documented, not fixed: a repeated attempt re-adds a routed job whose first copy already finished (known-issues row 14); an
  old sender fails a queue route's events and can auto-pause it during a rolling deploy; the stats read's cost is unmeasured.
- Disclosed, not fixed: the unbounded backlog `count(*)` in the stats read (bounded by the 24 h expiry); the second `list()`
  in `GET /webhooks/deliveries` (one read of at most 100 routes); the enable lock taken on every enable, kept on purpose.

**Security review**, by hand (the `security-review` skill needs an `origin/HEAD` that this repository, which has no remote,
lacks): outbound path, the queue-route enqueue, the feed's SQL and the new routes. No finding beyond the secret above.
Feed SQL is parameterised with fixed clause text; a driver error is never quoted into an event, only the store's own
refusals; the new feed returns the same wire as the existing per-route history; writes are operator-only, rate-limited and
audited with the route id alone. Read routes (stats included) are not rate-limited, as for every read route.

**Gate**, local Postgres 18 (Homebrew, port 55442), `QCLOUD_REQUIRE_DB=1`: `typecheck`, `lint` (exit 0, warnings only),
`format:check`, `architecture` and `docs:check` pass; `bun test` gives 5324 pass, 252 skip, 1 fail. The failure is
`test/docs/release.test.ts` "package metadata", the LICENSE line that fails at `HEAD` too. `test:model` was not re-run after
the final fixes (they touch webhooks, not queue semantics); it passed for task 09.

**Not run:** Playwright e2e and the 390/1440 clip sweeps; the Docker, PgBouncer, TLS, Pub/Sub, ElasticMQ and real-cloud suites
(the 252 skips); Hookdeck's own dashboard (Google refused the sign-in in the browser I launched; the screen map is from the
public docs).
