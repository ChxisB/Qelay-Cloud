# 21 — Infra: GCP Terraform

**Status:** done locally (apply not run: needs D9) · **Depends on:** 17, 20 · **Phase:** 1

## Goal

Reproducible GCP infrastructure for one Qelay-Cloud environment: database, doorbell topics and subscriptions, workers, scheduler, identities and secrets.

## Scope

In: Terraform modules and an example environment under `infra/gcp/`, validated and planned in CI without credentials.
Out: applying to a real project (needs D9); the control-plane service itself (task 36).

## Gate decisions (task 06)

Binding. Evidence: [docs/spikes/06-phase0-gate.md](../../../docs/spikes/06-phase0-gate.md) ("Connection and driver
contract"), [spike 05](../../../docs/spikes/05-db-access-and-delay.md), DESIGN.md section 7.

- **The connection ceiling is part of the plan.** `direct = sum(count x (pool + listen)) + 6`; the worker's
  `concurrency` is not in it. `max instances x pool` (default pool 2) for every Cloud Run service is checked against
  the database's `max_connections` by a Terraform `precondition` or validation, so a plan that cannot fit is refused
  before an apply. Every Cloud Run service sets `max_instance_count` explicitly (an unbounded one has no budget).
  The README prints the budget for the example: 10 / 50 / 200 worker processes at pool 2 need 32 / 112 / 412 direct
  connections (plus 3 control processes), or 26 pooled. A 25-connection shared-core tier fits about 9 processes, and
  that figure is derived, not measured.
- **The Cloud SQL connector is a tunnel, not a pooler.** The Auth Proxy and the `/cloudsql` socket authenticate and
  encrypt; they share nothing. Managed pooling exists only on Enterprise Plus. Offer a `pooler` option
  (off by default): when set, workers receive the pooled URL, `prepare: false`, role-level `ALTER ROLE ... SET` for
  schema and timeouts, and a separate direct URL for `LISTEN` (task 16). Recommend a pooler above about 80% of
  `max_connections`.
- **TLS is configured, not assumed.** The driver defaults to plaintext. Require encrypted connections on the
  instance and give workers the CA through env or secret. Cloud SQL's certificate is CN-only, so hostname
  verification is **not proven** and goes in the README's "needs D9" list. A `/cloudsql` socket on Cloud Run is
  reached through `path`.
- **Messaging is one topic per environment and a filtered subscription per queue**, generated from the `queues`
  variable, plus a dead-letter topic and subscription (task 17). The dead-letter depth alert is an input to task 71.
  A queue added to `queues` is the only way a new queue gets a doorbell path.
- **Cloud Scheduler stays at one minute** and is the cron source and the safety net. Always-on workers (D1) set
  `min_instance_count >= 1` and may run the in-process tick (task 20); it never replaces the scheduler job.
- **Workers also publish.** The in-process tick and the SDK ring from the worker, so the worker service account keeps
  publisher on its topic (already in step 2). The README lists it.

## Steps

1. **Modules:** `network` (VPC, private services access), `database` (Cloud SQL Postgres 16, private IP, automated backups and point-in-time recovery, deletion protection on, maintenance window, `max_connections` set from the budget above),
   `messaging` (topic, per-queue subscriptions, dead-letter topic and subscription, retry policy, `maxDeliveryAttempts`),
   `workers` (an example Cloud Run service with min instances per D1, the SDK's required env), `scheduler` (Cloud Scheduler job with OIDC to the tick endpoint), `secrets` (Secret Manager for the DB credential), `iam`, `monitoring` (alert policies as inputs for task 71).
2. **Identities, least privilege:** separate service accounts for workers (subscriber on its subscriptions, publisher on its topic, Cloud SQL client, secret accessor for one secret), the tick (publisher, Cloud SQL client), and the scheduler (invoker of the tick only). No project-wide roles.
3. **Queue provisioning:** filtered subscriptions are created from a `queues` variable (name, ack deadline, max delivery attempts). Document that adding a queue is an infra change on GCP and decide whether the SDK may create them lazily (default: it may not).
4. **State and safety:** remote state backend as a variable; `prevent_destroy` on the database; outputs for the connection name, topic and subscription names, and the tick URL.
5. **CI:** `terraform fmt -check`, `terraform validate`, and `terraform plan` against a mocked/no-op provider configuration where credentials are unavailable. Add `tflint` if it is already in use in your other projects.
6. **Docs:** `infra/gcp/README.md`: variables, required APIs, the apply order, cost drivers (the database is the floor), and the teardown steps. The `terraform-iac` skill's checklists apply (state drift, unwanted replacement, IAM scoping).
7. **Apply (needs D9):** if a project is supplied and applying is allowed, apply the example environment, run task 22's end-to-end check against it, then destroy or hand over, per your instruction. Record what was created.

## Acceptance

- `terraform validate` passes and `terraform plan` shows the expected resources for the example environment.
- No resource uses a primitive or project-wide role; each service account's roles are listed in the README with the reason.
- The database has deletion protection and backups enabled in the plan.
- A plan whose `max instances x pool` exceeds `max_connections` fails a precondition, and the README shows the budget for the example.
- Each queue has its own filtered subscription in the plan, and the dead-letter depth alert input exists.
- Applying, if done, leaves nothing running unintentionally. The Result says what exists.

## Verify

```bash
terraform -chdir=infra/gcp/example fmt -check -recursive
terraform -chdir=infra/gcp/example init -backend=false && terraform -chdir=infra/gcp/example validate
```

## Risks / notes

- Do not run `apply` or `destroy` without D9 and an explicit instruction. A plan is the default deliverable.
- Private-IP Cloud SQL plus Cloud Run needs Direct VPC egress or a connector; task 05 found the connector is a tunnel, so the choice does not change the connection budget.
- Costs: the database dominates. State the smallest sensible tier and the HA trade-off in the README rather than defaulting to the largest.

## Result

**Done as a plan, never applied.** `terraform apply` and `destroy` were **not run** (step 7 needs D9 and the user's go-ahead); no
resource exists in any project, and no `gcloud` command was run. Everything below was checked with `terraform fmt`, `init -backend=false`,
`validate` and `plan` against a placeholder access token, with every `GOOGLE_*` and `CLOUDSDK_*` variable dropped.

**Delivered** (`infra/gcp/`, see its README)

- Ten modules: `network`, `database`, `budget`, `messaging`, `secrets`, `iam`, `workers`, `tick`, `scheduler`, `monitoring`; the
  example environment `example/` (52 resources to add with the CI values), `ci.tfvars.example`, `backend.tf.example` and a committed
  `.terraform.lock.hcl` (google 6.50.0, random 3.9.1; linux and macOS, amd64 and arm64).
- `bun run check:terraform` (`scripts/check-terraform-plan.ts`, `terraform-plan-assertions.ts`, `terraform-plan-model.ts`): fmt,
  init, validate, the lock file, `prevent_destroy`, the plan, and **109 assertions**. CI job `terraform` runs it with
  `QCLOUD_REQUIRE_TERRAFORM=1`.
- `QCLOUD_DATABASE_POOL_SIZE` in `packages/maintenance/src/env.ts` (positive integer, else `UnsupportedOptionError`), with tests; the
  tick's usage text mentions it. The budget counts `pool_size` per process, so the process had to read it.
- Docs: `infra/gcp/README.md`; the gate document's "The GCP infrastructure as built (task 21)" and an amendment; DESIGN.md section 7;
  the repo `CLAUDE.md` (`check:terraform`); `*.tfplan` is gitignored.

**Acceptance**

- `validate` passes and the plan has the expected resources: yes (52 to add).
- No primitive or project-wide role: the plan check fails on a project, folder or organization IAM resource, on any role outside the
  five, and on `allUsers`. The README lists each role with its reason.
- Deletion protection (API and instance setting), backups and point-in-time recovery are in the plan; the plan check asserts them, and
  mutation runs (PITR off, an `editor` role, a wrong filter, a budget without LISTEN) were each caught and then restored.
- A fleet over `max_connections` fails a `terraform_data` precondition: 60 instances at the default 100 is refused ("max_connections is
  100"); the same fleet behind a pooler is accepted. The README prints the budget (10 / 50 / 200 workers: 32 / 112 / 412 direct, 26
  pooled), and the check compares it with the TypeScript `budget()` for those sizes with and without a listener per process.
- Each queue has its own filtered subscription and dead-letter subscription, with the names `packages/transport-gcp` computes; the
  dead-letter depth alert covers every dead-letter subscription.
- Applying: not done, so nothing is running.

**Checked**

- `bun run typecheck && bun run lint && bun run format:check && bun run architecture`: clean (432 files within the cap; the plan
  assertions had reached 310 lines and were split into `terraform-plan-model.ts`).
- `bun run check:terraform`: 109 checks passed (nine consecutive runs after the last change). One earlier run exited 1 right after
  `architecture` with its diagnostic cut off by `tail`; it was not reproduced. The script now passes `-no-color` so a failure prints as
  plain text.
- `bun test` on local PG 18 with `QCLOUD_REQUIRE_DB=1` and the Pub/Sub emulator: 1,712 pass, 54 skip, 1 todo, 0 fail. The skips are the
  PgBouncer, TLS and ElasticMQ suites (Docker, owed at the end).

**Refinements to the task text** (all recorded in the gate document)

- **No Cloud SQL IAM role.** Step 2 listed "Cloud SQL client"; a direct private-IP connection with a password over TLS needs none.
- **The CA is a second secret** (a file mount), so the workers and the tick each have two accessor bindings.
- **A `tick` module of its own**, rather than the worker module reused: different ingress, scaling, invoker and secrets.
- **`project_number` is a variable**, not `data.google_project`, so a plan needs no credentials.
- **The audience is the deterministic Cloud Run URL** (a resource cannot read its own URL into its own environment); a `check` block
  compares it with the real `uri` after an apply.
- **`QCLOUD_DATABASE_POOL_SIZE`** added to the tick's environment reader.
- **The pooled budget counts LISTEN connections**, as the TypeScript `budget()` does; the first draft left them out and the
  cross-check caught it.
- **`listen_connections` defaults to 0**: on GCP nothing holds a LISTEN connection (`QueueEvents` polls; the Pub/Sub transport rings by
  message). It exists for a service on the local `postgres` transport.
- **`ensureQueue` (the SDK's dev helper) does not set `expiration_policy { ttl = "" }`**, so a subscription it creates expires after 31
  days without a pull. The Terraform sets it. Not changed here; the README says to use the Terraform for anything that lives.
- **Not done by design:** no pooler is created (the `pooler` variable points at one), no SQL is run (so role-level `ALTER ROLE ... SET`
  for a pooler is the operator's, and the defaults need none), and the control plane's service account waits for task 36.
- **Teardown** gained `abandon_peering_on_destroy`, because the private services peering can refuse to delete while Cloud SQL releases
  its end.

**Needs D9** (the README's list, none of it run): TLS hostname verification with the mounted CA against Cloud SQL's CN-only
certificate; Direct VPC egress reaching the private IP; dead-lettering with the Pub/Sub service agent's grants; the `max_connections`
value the tier accepts; the deterministic audience; OIDC accepted by both Cloud Run IAM and the tick; `ttl = ""` accepted; the subnet
sizing (`2 x (sum of max_instances + 1)`, derived, not measured); the alert metric filters; the secret mount's path and mode.
`tflint` was not added (it is not installed here and the task made it conditional).

**Hand-offs**

- **Task 22:** `docs/limits.md` quotes the lateness table of task 20 and lists every `QCLOUD_*` variable `env.ts` reads, including
  `QCLOUD_DATABASE_POOL_SIZE`; the scenario suite on a real project is step 7 here and stays D9.
- **Task 36:** the control API's service account, secrets and the fourth control process join the iam module and `control_processes`.
- **Task 71:** the four alert policies (`dead_letter_depth`, `backlog_age`, `database_connections`, `scheduler_failures`) are its inputs.
