# Task 72: Security review (2026-10-17)

**A self-review by the author of the code, done locally. One medium finding (F-2) is open and needs your decision, so acceptance bullet 1 is not met.** Nothing was
applied, pushed or published; no real cloud, no Docker, no migration. Report: `docs/security/review-v1.0.0.md`. Model: `docs/security/threat-model.md`.

**Changed files**

- `packages/control-api/src/http/router.ts` (`operatorOnly` on a route), `packages/control-api/src/app.ts` (enforced once, 403 `forbidden`),
  `packages/control-api/src/routes/{audit,ops}.ts` (`GET /audit` and `GET /transport/dead-letters` declare it; the inline role checks are gone).
- `scripts/security-routes.ts` and the `security:routes` script in `package.json`; `docs/security/routes.md` (generated);
  `packages/control-api/test/security.routes.test.ts` (5 tests).
- `.gitleaks.toml`.
- `docs/security/{threat-model,review-v1.0.0}.md`; the namespace caution in `docs/concepts.md`; the decode-amplification limit in `docs/limits.md` section 13; the links in `docs/operations.md`.
- `.claude/.planning/v1.0.0/{72-security-review,CURRENT}.md`.

**Checked**

- *Routes:* all 105 against their role, from the routes the app serves (1 public, 46 viewer or operator, 58 operator only); 401 with no or a bad token (not echoed), 403 for a viewer on every operator row.
- *Secrets:* gitleaks 8.30.1 on the working tree, no leaks after allow-listing four fixture values. No history exists to scan.
- *Dependencies:* `bun audit`, no vulnerabilities in 289 packages.
- *SQL:* the 28 `.unsafe(` sites in 14 files, all constant text or constant fragments; the schema is a startup parameter.
- *Decoding:* hostile msgpack against the real codec: huge declared lengths fail at once, deep nesting is a `RangeError`, a bad RegExp is a `SyntaxError`, an unknown Error class is a plain `Error`. **A flat array of tiny elements decodes to 19 times its size** (F-2, below).
- *Webhooks:* re-read the sender against its documented defences. Sound on reading; low note F-3. An independent review is still owed.
- *Infrastructure:* read 104 `.tf` files. Database private and TLS-only on both clouds, encrypted at rest, backups and deletion protection on, IAM resource-scoped, no keys or users, the only `allUsers` grants are the documented public exposure.
- *Dockerfiles:* read, not built (digest-pinned slim base, non-root `bun`, root-owned files, production install, no scripts).

**Run**

- Full gate on the final tree of tasks 71 and 72 (2026-10-17, PG 18.6 at 55442, Pub/Sub emulator, ElasticMQ, `QCLOUD_REQUIRE_DB/SQS/PUBSUB/TERRAFORM=1`, under `caffeinate`): `typecheck`, `lint` (0 errors, 2 existing panel warnings), `format:check`, `architecture` all exit 0; `bun test` 4,984 pass, 29 skip, 0 fail, 5,014 tests in 495 files, 1,104 s. The two skip warnings printed are the PgBouncer and TLS-Postgres suites (Docker deferred); the other skips were not itemised.
- `bun audit`, `bun run security:routes --check` and the gitleaks scan, on the final tree.

**Decisions**

- `operatorOnly` is separate from `access: 'write'` on purpose: an operator-only read is not audited and not rate-limited like a write.
- Severity was not lowered to meet the acceptance list. F-2 is rated medium (availability of the control plane only), left open and escalated.
- F-2 was measured before it was rated: 20 jobs of one million `null`s each (1 MiB encoded) through `GET /queues/:queue/jobs/list` on Postgres 18 grew the API process by 357 MB in 300 ms.
  The scratch test that did it was deleted.
- The fix for F-2 narrows what a payload may be, so it was not made without your decision.

**Found and fixed**

- F-1: two operator-only reads were enforced per handler. Now declared and enforced in one place, and held by the generated table.
- F-8: four test fixtures tripped the secret scanner. Allow-listed, not secrets.

**Owed**

- **F-2 (medium, open): your decision.** Options: (a) cap decoded elements at enqueue (the number is the decision; 250,000 would pass any realistic payload), (b) decode lazily one job at a time in the list route,
  (c) accept it. Recommended: (a) and (b). Until then the documented mitigation is a low `QCLOUD_API_MAX_PAGE_SIZE` and enough task memory.
- **F-5: images not built or scanned, no SBOM.** Owed with the Docker run. The release in task 73 should not claim scanned images.
- **An independent test**, starting with the webhook sender (address-class parsing, connection pinning) and what the panel shows to a `viewer`.
- **F-4: the public exposure default** has no web application firewall or edge rate limit. Use `exposure = "private"` or identity-aware access for sensitive payloads.
- No test walks every store query for its namespace filter: a future query that forgets it is not caught.
- Provider-side secret rotation and the real-cloud checks that D9 holds back.
