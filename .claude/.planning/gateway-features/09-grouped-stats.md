# 09 — Grouped stats

**Status:** done · **Depends on:** 06 · **Touches:** packages/store-postgres, packages/control-api, docs/openapi.yaml

## Goal
`GET /webhooks/stats?groupBy=webhook`: one read, one entry per route.

## Steps
1. `webhookGroupStats.ts` reuses the window checks; counts and a trend, no latency.
2. Route, openapi, an indexes-test row.

## Acceptance
- Every route of the namespace is in the answer, with zeros when it had no events.
- The counts equal the single-route read for the same window.
- The query uses the partition key and an index (plan test).

## Verify
```bash
QCLOUD_REQUIRE_DB=1 bun test packages/store-postgres packages/control-api
```

## Risks / notes


## Result
store.webhooks.statsByWebhook (store-postgres/src/store/webhookGroupStats.ts): one grouped count over the window plus one lateral probe of the pending-delivery index per route; counts, failure ratio, backlog and per-slice trend, no latency; every route of the namespace is an entry (zeros for a quiet one); the window checks are the single-route read's (checkedWindow exported from webhookStats.ts). GET /webhooks/stats?groupBy=webhook answers {since, until, bucketMs, groups} (webhook with groupBy is a 400; without groupBy nothing changes); openapi has the groupBy parameter, a oneOf 200 and WebhookGroupStatsEnvelope. Tests: store-postgres/test/webhook.stats.group.test.ts (4: zeros, equals the single-route read for counts, ratio, backlog and every slice, window outside, same refusals), control-api/test/webhooks.stats.group.test.ts (4), the openapi fit check, and a planned row in schema.planned.webhook.ts (uses qcloud_deliveries_history_idx; schema.indexes passes). No migration. Ran on local PG 18.6: store-postgres + control-api 2504 pass, 22 skip, 1 fail: read.plans.aux 'throughput of the whole fourteen days' (a metrics plan test I did not touch; planner chose Bitmap+Sort; it failed 3 of 4 runs of that file and passed the 4th, so it is a flaky plan check on this machine, to report). Typecheck, oxfmt, oxlint, architecture, docs:check clean. Not run: playwright, Docker-backed suites.
