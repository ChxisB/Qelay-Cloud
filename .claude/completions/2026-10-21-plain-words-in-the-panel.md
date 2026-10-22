# Plain words in the panel (2026-10-21)

The panel said doorbell, tick, broker and claimable. It now says the same things in plain words. The glossary is in
[docs/concepts.md](../../docs/concepts.md#the-same-things-in-plain-words).

| Was | Now |
| --- | --- |
| doorbell | worker notification |
| claimable | ready to run |
| no doorbell / not rung | not notified |
| broker / transport (labels) | queue service |
| in flight | picked up |
| poison doorbell, broker dead-letter queue | failed notifications |
| tick | maintenance |
| Transport (page, nav, title) | Job delivery |
| round trip | response time |

## Changed

- Panel: `Transport.tsx`, `transport/{QueueDoorbellTable,DeadLetterPanel}.tsx`, `deployment/{Facts,WarningList}.tsx`,
  `Deployment.tsx`, `overview/StatusStrip.tsx`, `lib/ops/health.ts`, `navConfig.ts`, `pageTitle.ts`.
- Control API: the sentences in `ops/warnings.ts` that the Deployment page shows. Warning codes are unchanged.
- Tests that pin wording: panel `ops-*`, `shell`, `page-tables-11`, e2e `deployment` and `walkthrough`, control-api `ops.warnings`.
- Docs: stale "Transport page" names, `concepts.md` glossary, `PORTING.md` row.

## Not changed (on purpose)

- Routes (`/transport`), API fields (`notRung`, `doorbellDepth`), warning codes, metric names, alert names, Terraform
  descriptions, DESIGN.md, the runbooks' own wording and `docs/spikes/`. They keep the design's words.
- The Fleet page says "broker" for a Qelay server node. That is upstream's meaning and differs from "queue service".

## Verified

`typecheck`, `lint`, `format:check`, `architecture` clean. `bun test packages/panel packages/control-api`: 1880 pass.
Full `bun test` ran without Postgres, Pub/Sub or ElasticMQ, so database suites skipped. One failure is not from this
change: `test/docs/release.test.ts` "package metadata" (a package LICENSE differs from the root one). The Playwright
e2e specs were type-checked and updated but not run.
