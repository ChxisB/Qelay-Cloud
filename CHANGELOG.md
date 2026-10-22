# Changelog

Qelay-Cloud follows [semantic versioning](https://semver.org/). The one open release is below; it is not published and the
packages are still `0.0.0` ([release checklist](docs/release-checklist.md)).

## [1.0.0] - not released

A Qelay-shaped job queue on managed cloud services. **Postgres holds every job.** Google Pub/Sub or Amazon SQS only rings a
doorbell to wake workers, and one idempotent tick repairs whatever a failure left behind ([concepts](docs/concepts.md)).

> **Verified on emulators only.** The Pub/Sub transport ran against Google's emulator and the SQS transport against ElasticMQ
> 1.7.1. Nothing was run on a real Google Cloud project or AWS account (no `terraform apply`, no deploy), and all database
> tests ran on PostgreSQL 18.6 although 16 is the documented minimum. What that does not prove is listed in
> [known issues](docs/known-issues.md) and [limits, section 8](docs/limits.md#8-what-has-not-been-run).

### Added

- **SDK (`qelay-cloud`)**: `Queue`, `Worker`, `QueueEvents` and `FlowProducer` with Qelay's names. Jobs are rows in Postgres,
  settled only by the worker that holds the current lease; delivery is at least once. Delay, priority, deduplication, groups,
  rate limits, concurrency, cron, retries with backoff and a dead-letter queue are options of the job and columns of its row.
- **Store (`@qelay-cloud/store-postgres`)**: the schema, 19 forward-only migrations safe with the previous release still
  connected, a connection budget that is a formula, and a model harness that checks the store against a reference model.
- **Transports**: `postgres` (workers poll, no cloud account), in-memory, Google Pub/Sub and Amazon SQS, behind one contract
  suite that runs the same scenarios on each.
- **Maintenance tick (`@qelay-cloud/maintenance`)**: lease recovery, cron, due and delayed jobs, re-ringing, retention and
  workflow recovery. Run it from Cloud Scheduler or EventBridge (up to a minute late) or inside an always-on worker (seconds).
- **Flows**: parents that wait for children across queues, written in one transaction, with a Control API tree and a panel page.
- **Webhooks**: signed, at-least-once events to receivers you register, with addresses checked at connect time (public
  addresses only, no redirects), secrets sealed at rest and shown once.
- **Event gateway** (the panel's Webhooks page, renamed): a webhook is a connection with a source queue and a destination, an
  address or another queue, with loops refused when it is saved. Connections have a name and a description and are edited
  in place (`PATCH /webhooks/{id}`); rules are a filter, de-duplication, a shape and a delay, all declarative data. A
  connection is paused (events are held and sent on resume) or disabled (events are ignored). Issues are stored state that
  an operator can acknowledge, ignore or resolve, and destinations can be saved and shared (a copy stays on each
  connection). The connections list shows each connection's last 24 hours from one grouped read. No inbound HTTP source
  exists yet ([event gateway](docs/event-gateway.md)).
- **Workflow engine**: durable steps, branches, loops, signals, waits and compensation, stored as rows and run as ordinary
  jobs, with operator actions in the Control API and the panel.
- **Control API (`@qelay-cloud/control-api`)**: 105 routes in front of the same Postgres and the broker's metrics, signed in
  with OpenID Connect (a development token outside production), roles `viewer` and `operator`, every write audited. The table
  of who may call what is generated: [docs/security/routes.md](docs/security/routes.md).
- **Panel (`@qelay-cloud/panel`)**: the React control panel for queues, jobs, flows, workflows, workers, the dead-letter
  queue, cron and webhooks.
- **Infrastructure**: Terraform for GCP and for AWS (data plane and control plane) with safety settings asserted by a
  credential-free plan check.
- **Telemetry (`@qelay-cloud/telemetry`)**: OpenTelemetry metrics and traces for the tick and `Queue.add`, alert definitions,
  16 runbooks and a local game day that drills them.
- **Security**: a threat model and a self-review ([review-v1.0.0](docs/security/review-v1.0.0.md)), one finding fixed and one
  medium finding open.
- **Documentation**: quickstarts for local, GCP and AWS, concepts, architecture, operations, limits, a migration guide from
  Qelay, and a docs checker that runs in the gate.

### Compatibility with Qelay

Qelay-Cloud covers the BullMQ-style core of Qelay (decision D6). Of 189 public methods and options compared in
[compat.md](docs/compat.md): 44 are the same, 66 differ in a way the table states, 24 are new here and 55 are not supported.
Each unsupported one throws `UnsupportedOptionError` naming the option, or answers `501 not_supported`; nothing is ignored
silently ([unsupported.md](docs/unsupported.md)). Not in 1.0.0: repeat jobs, job-group admin methods, manual retry of failed
jobs and dead-letter replay, batch processing, the Qelay TCP server and embedded mode.

### Known limitations

The full list, with what decides each, is [docs/known-issues.md](docs/known-issues.md). The ones to read first:

- A payload can decode to far more memory than its 1 MiB, so an untrusted enqueuer can exhaust the Control API's memory
  (finding F-2, open).
- The Control API and panel are public by default with no web application firewall, and a viewer sees payloads.
- A namespace is a convenience for environments, not a tenant boundary.
- Container images were not built or scanned and there is no SBOM.
- The security review is by the author; an independent test is owed.

### Migration notes

- **From Qelay**: [Moving from Qelay](docs/migration.md). Every method is async here, a `Queue` sees only its own queue, and a
  handler must be idempotent.
- **Database**: PostgreSQL 18 or later. Run `qcloud-api migrate` as a release step before the services; services never migrate
  on start. Migrations are forward-only, so a rollback serves the previous revision against the migrated database
  ([operations](docs/operations.md#upgrading)).
- **Tables** are prefixed `qcloud_`, never `qelay_`.

### Licence

MIT. The upstream notice (Qelay) is in [LICENSE](LICENSE), [docs/PORTING.md](docs/PORTING.md) records where each ported
file came from, and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) covers the dependencies.
