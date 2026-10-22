# 06 — Docs, gate and hand-off

**Status:** done · **Depends on:** 01–05 · **Touches:** docs/event-gateway.md, .claude/completions, packages/panel/README.md (only if a path is listed there)

## Goal
The docs say what the screens do now, the gate ran, and the owner has the list of what needs a decision.

## Steps
1. `docs/event-gateway.md`: "In the panel" describes the table view, the connection page and its three tabs, the timeline,
   saved views and the create page. "Not built" lists G1 to G5 with what each needs. Remove "Rotating a secret in the panel".
2. `bun run docs:check`, then the full gate from CLAUDE.md with Postgres up and `QCLOUD_REQUIRE_DB=1`.
3. Review the diff by hand against the rules of the panel README (files under 300 lines, English, sentence case), and for
   the secret on screen (task 03). The security-review skill cannot run here (no `origin/HEAD`), so say so.
4. `.claude/completions/2026-10-21-gateway-ui.md`: changed files, what ran and against what, what did not run.

## Acceptance
- `docs/event-gateway.md` matches the screens; `bun run docs:check` passes.
- The full gate passes, apart from failures that fail at HEAD and are named.
- The completion doc lists what was not run (Playwright, 390/1440 sweeps) and what needs the owner (G1 to G5).

## Verify
```bash
bun run docs:check
bun run typecheck && bun run lint && bun run format:check && bun run architecture && bun test
```

## Result

**Docs.** `docs/event-gateway.md`: "In the panel" now describes the table view, the connection page and its three tabs, the
timeline, saved views and the create page (including the one-time secret); "Not built" lists G1 to G5 and what each needs;
"Rotating a secret in the panel" is gone because the Settings tab does it. `bun run docs:check` passes (7 documented blocks run).

**A bug found in the hand review, fixed with a test first.** `POST /webhooks` with no secret makes one when the deployment has
a signing key and the destination is an address (`store/webhooks.ts`), and returns it once in `data.secret`. The create page
dropped it, so the new connection said "Every event is signed" and nobody had seen the secret. The test
(`gateway-create-secret.test.tsx`) failed first: the page navigated away. Now the page keeps the secret in component state,
shows it with a copy button, and waits for **Open connection**. The banner moved to `SecretBanner.tsx`, shared with the
Settings tab. A secret typed or generated on the page is not returned by the server, so that path still opens the connection
straight away.

**Hand review of the diff.** Files are under 300 lines (`architecture` enforces it), copy is English and sentence case. The
secret is in state only: a grep of the gateway pages finds no storage, toast, console, router-state or `innerHTML` use
that touches it, and tests assert it is in neither storage nor the toast store. The security-review skill could not run (no
`origin/HEAD`), so this was read by hand, not by that skill.

**Gate, local Postgres 18 (Homebrew, port 55442), `QCLOUD_REQUIRE_DB=1`:**
- `typecheck`, `lint` (warnings only, none new apart from three `set-state-in-effect` on scope-reset effects), `format:check`,
  `architecture`, `docs:check`: pass on the final tree.
- `bun test`: 5387 pass, 252 skip, 1 fail, in 686 s. The one failure is `package metadata > every package is MIT ...`: it wants
  the upstream copyright line in `LICENSE`, which HEAD (`4103cee`) removed. It fails without this change and is the owner's call.
  An earlier run, which started before the secret fix, had 4 fail and 1 error that did not recur; they were not looked at
  one by one. Earlier sessions saw the game-day `database.test.ts` and `read.plans.aux.test.ts` flake.
- `bun test packages/panel`: 1671 pass, 0 fail.

**Not run:** Playwright e2e, the 390 and 1440 width sweeps, `test:model` (no queue-semantics change), Docker, PgBouncer, TLS,
Pub/Sub and ElasticMQ suites (the 252 skips). The security-review skill. Nothing was committed or pushed.
