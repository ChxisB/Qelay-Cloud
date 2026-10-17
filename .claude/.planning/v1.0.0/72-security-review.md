# 72 — Security review

**Status:** done locally, with one medium finding open (F-2) and container scanning not done · **Depends on:** 43, 52 · **Phase:** 6

## Goal

A deliberate security pass over the whole system before anyone outside the project uses it, with findings fixed or explicitly accepted.

## Scope

In: threat model, review of auth, authorisation, input handling, secrets, dependencies, containers, infrastructure and webhooks, fixes, and a written result.
Out: a third-party penetration test (recommend one; do not claim this task replaces it).

## Steps

1. **Threat model** (`docs/security/threat-model.md`): assets (job payloads, credentials, the database), actors (viewer, operator, a compromised worker, an external attacker, a malicious webhook target), trust boundaries (panel ↔ API, API ↔ DB, workers ↔ transport, scheduler ↔ tick), and the main abuse cases.
2. **AuthN/AuthZ review:** every Control API route against its required role (generate the route table and check it against tests); JWT validation edge cases (`alg: none`, key confusion, audience and issuer mixes, expired and not-yet-valid tokens); the dev token cannot run in production; the tick endpoint's identity check; per-namespace isolation.
3. **Input handling:** payload size limits at every entry point; SQL parameterisation (a grep and a review of every dynamic-SQL site, especially anything building identifiers from queue names); msgpack decoding of untrusted payloads (resource limits, prototype pollution, extension types); JSON-safe encoding in the API; SSE and list-endpoint limits.
4. **Webhooks:** re-review the SSRF defences (task 52) including DNS rebinding and redirect handling; signature scheme; secret handling.
5. **Secrets:** none in the repo (run a secret scanner over the working tree), none in logs, none in API responses, the database credential delivered through the cloud secret manager only; rotation tested.
6. **Dependencies and containers:** audit direct and transitive dependencies; pinned versions; container images scanned, non-root, minimal; SBOMs published with release artifacts.
7. **Infrastructure:** review IAM statements and network exposure in the Terraform (public endpoints only where intended; database not publicly reachable; encryption at rest and in transit; backups and deletion protection on).
8. **Multi-tenant caution:** state in the docs that namespace isolation is a convenience for environments, not a hard multi-tenant boundary, unless the review shows otherwise.
9. **Report** `docs/security/review-v1.0.0.md`: findings with severity, status (fixed, accepted with reason, deferred with owner), and what the review did not cover.

## Acceptance

- No open high or critical finding; every medium is fixed or has a recorded acceptance reason.
- The route-authorisation table is generated from code and every row is covered by a test.
- A secret scanner reports nothing on the working tree.
- The report states plainly that it is a self-review and recommends an independent test before production use with sensitive data.

## Verify

```bash
bun run typecheck && bun run lint && bun run format:check && bun run architecture && bun test
bun audit
bun run security:routes             # defined by this task: prints the route/role table
```

## Risks / notes

- A self-review has blind spots. Say so in the report and let the user decide whether to commission an independent review before publishing.
- Do not downgrade a finding's severity to meet the acceptance criterion; escalate it to the user.

## Result

**Done locally (2026-10-17) as a self-review, with acceptance bullet 1 NOT met: one medium finding (F-2) is open and needs your decision.** Nothing was applied, pushed
or published; no real cloud, no Docker, no migration. Completion record: [.claude/completions/2026-10-17-72-security-review.md](../../completions/2026-10-17-72-security-review.md).
The report is [docs/security/review-v1.0.0.md](../../../docs/security/review-v1.0.0.md); the model is [docs/security/threat-model.md](../../../docs/security/threat-model.md).

Acceptance:

- *No open high or critical finding; every medium is fixed or has a recorded acceptance reason:* **not met.** No finding is rated high or critical. Of the mediums, F-4 (public
  exposure is the default) and F-7 (viewers see payloads) have recorded acceptance reasons. **F-2 has none, because I did not think accepting it was mine to decide:** the 1 MiB
  payload cap is on encoded bytes, a payload of a million `null`s decodes to about 19 MB, and 20 of them made one Control API list call grow the process by 357 MB (500 fit in a
  page). A fix narrows what a payload may be, which changes the queue's contract, so it is yours to choose: cap decoded elements at enqueue, decode lazily in the list route, or
  accept it. The review recommends the first two together. Until then it is documented with its mitigation in `docs/limits.md` section 13. Container scanning (F-5) is also not done.
  I did not lower F-2's severity to make this bullet true.
- *The route-authorisation table is generated from code and every row is covered by a test:* **met.** `bun run security:routes` (`--write`, `--check`), `docs/security/routes.md`
  (105 routes: 1 public, 46 for a viewer or operator, 58 for an operator only) and `packages/control-api/test/security.routes.test.ts` (5 tests; a second public route fails it).
- *A secret scanner reports nothing on the working tree:* **met**, with gitleaks 8.30.1 and an allow-list of four test fixture values. The repository has no commits, so history was not scanned.
- *The report states plainly that it is a self-review and recommends an independent test:* **met**, at the top of the report and in its closing list.

What was changed: `operatorOnly` is a route property enforced once in `packages/control-api/src/app.ts` (F-1: `GET /audit` and `GET /transport/dead-letters` checked inline before);
`.gitleaks.toml`; `scripts/security-routes.ts`; `docs/security/{threat-model,review-v1.0.0,routes}.md`; the namespace caution in `docs/concepts.md`; the decode-amplification limit
in `docs/limits.md`; the links in `docs/operations.md`.

Not done: container images were not built or scanned and no SBOM was produced (Docker is deferred); the Terraform was read and planned, never applied; no independent test.

Verified with: Full gate on the final tree of tasks 71 and 72 (2026-10-17, PG 18.6 at 55442, Pub/Sub emulator, ElasticMQ, `QCLOUD_REQUIRE_DB/SQS/PUBSUB/TERRAFORM=1`, under `caffeinate`): `typecheck`, `lint` (0 errors, 2 existing panel warnings), `format:check`, `architecture` all exit 0; `bun test` 4,984 pass, 29 skip, 0 fail, 5,014 tests in 495 files, 1,104 s. The two skip warnings printed are the PgBouncer and TLS-Postgres suites (Docker deferred); the other skips were not itemised.
