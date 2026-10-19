# R18: a Pub/Sub topic per hot queue (review F13)

Date: 2026-10-19. Tracker: `.claude/.planning/review-2026-10-19/CURRENT.md`.

## What changed

- `packages/transport-gcp/src/names.ts` is the one place for the queue-to-topic map: `queueNames(ns, queue, hot)` returns
  `topic` (`qcloud.<ns>.hot.<queue>` for a hot queue, the shared `bells` topic otherwise) and `subscriptionFilter` (none on a
  hot queue's own topic). The dead-letter side stays shared and filtered.
- Transport: `GcpPubsubOptions.hotQueues`, a topic per queue in `ring` (`publisher.ts` takes `topicOf(queue)`), validated in the
  constructor. `TopologyOptions.hot` in `ensureQueue` creates the topic and an unfiltered subscription, and refuses (with the
  `removeQueue` then `ensureQueue` recipe) to reuse a subscription that is on the other topic. `removeQueue` deletes both topics' queue
  resources. `QCLOUD_GCP_HOT_QUEUES` (comma list) reaches the transport through `packages/transports`.
- Terraform: `queues.<name>.hot` in the messaging module (topic, subscription topic and filter, outputs `hot_topic_names` and
  `hot_queues`), publisher bindings for workers, tick and API (`hot_topic_names` into the iam module and the control plane),
  `QCLOUD_GCP_HOT_QUEUES` on the services that ring. The example's `queues` variable takes `hot`.
- Plan checks: `emails` is hot in both `ci.tfvars.example` files. The messaging check asserts the hot topic's name against
  `queueNames`, the subscription's topic and missing filter; the control-plane check asserts the API's publisher bindings.
- Tests: `names.test.ts` (hot names), `hot.test.ts` (ring and receive on a hot queue, the other queues unaffected, the
  provisioning refusal), `transports.test.ts` (the settings).
- Docs: `reference/configuration.md` (new row), `limits.md` (config row and "A hot queue" paragraph in section 11),
  `DESIGN.md`, `infra/gcp/README.md`, `runbooks/deploy-gcp.md`, generated `transports.md`.

## Verify

- `QCLOUD_REQUIRE_DB=1 QCLOUD_REQUIRE_PUBSUB=1 bun test packages/transport-gcp test/contract packages/transports` on the Pub/Sub
  emulator and scratch PostgreSQL 18.6: 225 pass, 36 skip (the SQS emulator was not running), 0 fail.
- `QCLOUD_REQUIRE_TERRAFORM=1 bun run check:terraform` (plan only, placeholder token): GCP 172, AWS 827, GCP control plane 128,
  AWS control plane 2664 checks pass.
- typecheck, lint (panel warnings only), format:check, architecture, `docs:check` clean.

## Not done / owed

- `terraform apply` and any real Pub/Sub run (D9). Whether a hot queue saves money or latency is read from Google's docs and not
  measured; the emulator does not bill.
- Moving a live queue between the topics is manual and a rollout needs every process to name the same list first (documented).
  Nothing detects a process with a stale list.
- More than about 5,000 queues (a second project) is not built. The plan check does not assert the worker and tick publisher
  bindings on the hot topics (the control-plane check does, for the API).
