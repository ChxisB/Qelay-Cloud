# Known issues in v1.0.0

Everything we know is open, unproven or limited in this release, in one place. [limits.md](limits.md) holds the measurements
behind most rows, [unsupported.md](unsupported.md) the Qelay features that are not here, and
[the security review](security/review-v1.0.0.md) the findings (F-1 to F-8).

**What is not on this list.** Delivery is at least once by design: a lease that expires while a job runs hands the job to
another worker, so a handler must be idempotent ([concepts](concepts.md#a-jobs-life)). That is a guarantee, not an issue.
No issue below is known to lose a waiting, delayed or active job. One replaces a finished job's record (section 1, row 2).

## 1. Open, and waiting for the owner's decision

| # | Issue | Effect | Decision or fix |
| --- | --- | --- | --- |
| 1 | **A payload decodes to far more memory than its 1 MiB** (security finding F-2, medium). The cap is on encoded bytes; a payload of a million nulls decodes to about 19 MB. | One list call over 20 such jobs grew the Control API by 357 MB. Anyone who can enqueue can exhaust the API's memory. | Cap decoded elements at enqueue and/or decode lazily in the list route ([limits section 13](limits.md#13-workflows-in-the-control-api-and-the-panel-task-62)). Until then keep `QCLOUD_API_MAX_PAGE_SIZE` small and let only trusted code enqueue. |
| 2 | **An enqueue in one queue replaces a finished job of the same custom id in another queue** (task 18). Job ids are unique per namespace. | The finished job's record and result are gone. No waiting or active job is touched. `version` restarts at 0. | Refuse it, or accept it. A change to core queue semantics, so it needs the model harness. |
| 3 | **The tick re-rings a deep healthy backlog every interval.** | A third to a half of the throughput on a 100,000-job drain. Nothing is lost; a bell that finds no work does nothing. | Let only first rings repeat within a run, or accept it with the 60 s scheduler interval. |
| 4 | **Three invariants of the upstream workflow model are relaxed** (task 61): a failed run may lack `rollbackStatus` until settled; a running map record exists while its node is current; a map transform runs once per engine generation. | Workflow runs can be observed in states upstream's model forbids. The relaxations are in the model tests. | The owner confirms them, or the engine is changed to keep upstream's. |
| 5 | **Container images were never built or scanned, and there is no SBOM** (F-5). | Known vulnerabilities in a base image or a layer are unknown. | Build, scan and attach an SBOM in the Docker run. |
| 6 | **The Phase 1 and Phase 2 sign-offs (tasks 22 and 37) were not given.** | The plan's gates closed locally without the owner's reading of their findings. | The owner reads both gate documents and signs. |
| 7 | **An exact rate limit serializes claims on one row; journal commits and per-queue metrics rows serialize per namespace or queue.** | A hot queue with a rate limit, or a hot namespace, tops out lower than the load checks suggest. | Spread hot work over queues, or accept it ([limits section 3](limits.md#3-throughput-and-latency-load-check)). |
| 8 | **Retention lags a burst**: 300,000 events and 200,000 envelopes remained after a 100,000-job drain, against a cap of 10,000 per queue, then recovered. | Storage stays high for a few ticks. | Raise `QCLOUD_TICK_MAX_ITEMS` if storage matters. |
| 9 | **The panel disables some destructive buttons, and its cron form refuses a name that exists.** | An operator uses the API for those. | Decide whether the panel should offer them, or leave them to the API. |
| 10 | **A `Bun.SQL` hazard was found in task 52 (a null inside a typed array) and the rest of the repository was not swept for it.** | Unknown. The one place found is fixed and tested. | Grep the store for array parameters. |

## 2. Never run, so not proven

Each line is something the tests and emulators cannot show. Nothing here is a known failure.

| Area | What is missing |
| --- | --- |
| **Any real cloud** (decision D9) | No Google Cloud project or AWS account was used. No `terraform apply`, no deploy, no real Pub/Sub or SQS, no Cloud SQL or RDS. Every cloud result is from the Pub/Sub emulator or ElasticMQ 1.7.1, which differ from the services ([limits section 9](limits.md#9-emulator-gaps-worth-knowing)). |
| **PostgreSQL 16** | The documented minimum, and the version CI uses. Every database test here ran on 18.6. The DDL snapshot and the `EXPLAIN` checks for migrations 6 to 11 are owed on 16. |
| **PgBouncer and TLS Postgres** | The suites exist; the Docker profiles they need were not started. |
| **GitHub Actions** | `ci.yml` and `nightly.yml` have never run, including the `terraform`, `transports` and documentation steps. The repository has no commits. |
| **Monitoring** | No alert has fired and no runbook has run on a real cloud, so nothing may be called "monitored". The game day is local. OTLP export was never exercised, and the shipped tick CLI exports no metrics. Alert metric names and thresholds are unverified defaults. |
| **Browsers** | Chromium and WebKit only. Firefox could not launch in the build sandbox. |
| **The quickstarts** | Nobody followed one from a clean machine, so "a newcomer has a job in the panel in 15 minutes" is not shown. The Compose step and both cloud quickstarts are marked `notrun`. |
| **Security** | The review is by the author. No independent test was done, and no git history was scanned (there is none). Start the independent test with the webhook sender's address checks and with what the panel shows a viewer. |
| **Cost** | Prices in the docs are list prices, not measured. |

## 3. Limits you will meet

- **Flows** hold at most 1,000 jobs and 100 levels. A child that fails with no failure policy holds its parent until the
  parent is cancelled. Cancelling or removing a parent leaves its children as ordinary jobs.
- **Webhooks** are at least once with no ordering. A backlog that outgrows the sender's rate is dropped after 24 hours.
- **Workflows**: the Control API holds no definitions, so an operator action is a claim plus a publish, and a lost publish
  waits up to five minutes for the tick. The tick skips `waiting` runs; a single-run recover reaches them. Compensation
  handlers are at least once across a crash. A sub-workflow polls and holds a worker slot. A run is read whole per request.
- **Tracing** covers `Queue.add` and `addBulk` only, with no `tracestate` or baggage.
- **Connections**: `Bun.SQL` opens all of `max` at once, so the budget is spent at start.
- **Namespaces** are a convenience for environments, not a tenant boundary ([threat model](security/threat-model.md#namespaces)).
- **Public exposure** is the control-plane default, with no web application firewall (F-4). Viewers see payloads (F-7).
- **Docs links into `.claude/`**: eight links (in `docs/security/phase2-pass.md` and `docs/spikes/`) point at the plan in
  `.claude/.planning/`, which is untracked. A clone without it fails `docs:check` ([release checklist](release-checklist.md#2-push-and-let-ci-run)).
- **Licences**: seven shipped packages carry no licence file in their tarball, so [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) lists them by the licence they declare.
