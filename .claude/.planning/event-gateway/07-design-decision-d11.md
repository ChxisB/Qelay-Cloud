# 07 — DESIGN.md decision D11: the event gateway

**Status:** done · **Depends on:** none · **Touches:** DESIGN.md (and nothing else) · **Gate: the owner signs off**

## Goal
The event gateway model is recorded as a decision before any migration, so nothing deviates silently.

## Steps
1. Add D11 to the decision table and a section 6 note: a webhook is a **route** = source (job events) + rules (`filter`,
   `shape`, rate, retry, pause) + a destination of a kind (`http`, `queue`, `workflow`); a delivery is an **event** with
   **attempts**.
2. State the rules that hold it together: no route, no effect; a route to an internal destination goes through the store's
   own enqueue (queue limits and dedupe apply); a depth cap (default 5) on the delivery and a cycle check on save; no user code.
3. State what stays out and why: inbound sources (public ingest at third-party volume needs its own service, `infra/` and
   a security review; D11 does not decide it), transforms in JavaScript, delay, dedupe, replay, Issues.
4. Reword the "Volume" line of section 6 so it matches: internal destinations are operator-scale writes in the same database.

## Acceptance
- DESIGN.md names D11 as Proposed, with the owner as the one who flips it to Decided.
- `docs/PORTING.md`, `known-issues.md` and `limits.md` are untouched (they follow in task 12).

## Verify
```bash
bun run docs:check
```

## Risks / notes
- This task writes no code. 08 to 12 do not start until the owner has answered.

## Result

**Done 2026-10-21; the owner decided D11 as recommended the same day.** `DESIGN.md` has D11 in the decision table (**Proposed**, then Decided) and an "Event gateway" note in section 6, after
the webhook notes. The "Volume" line now says a `queue` destination is a row write in the same database, so it stays
operator-scale. Nothing else was touched (`PORTING.md`, `known-issues.md` and `limits.md` follow in task 12). `bun run docs:check`
passes (the documented-commands step was skipped: Postgres is not up).

Three things the plan had wrong, now fixed in the plan files:
- **The number.** D10 is taken (shards, review R21). The decision is D11.
- **"Start a workflow" as a destination.** The Control API and the tick hold no workflow definitions and run no engine
  (DESIGN section 8), so they cannot start a run. D11 makes it a `queue` route whose worker calls `startWorkflow(name, data)`.
  A built-in `wf:start` job would change the engine every worker runs, and an older worker would fail it. Two destination kinds,
  `http` and `queue`, not three. This changes the user's answer ("a URL, a job, or a workflow") and is the first thing to confirm.
- **The depth cap.** A run-time depth carried on the delivery needs a column on the job and the event, on the claim and complete
  paths. D11 refuses loops on save instead (cycle check and a longest chain of 5, under an advisory lock) and has no run-time
  counter. A `queue` route needs a source queue.

Owner questions: flip D11 to Decided? Is "a workflow is a queue route" enough, or should the engine learn `wf:start`? Is the
save-time check enough, or do you want the run-time depth counter as well?
