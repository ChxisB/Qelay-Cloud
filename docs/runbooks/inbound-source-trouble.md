# Runbook: an inbound source or the ingest misbehaves

**When.** There is no alert for this: no ingest 5xx alarm was built ([observability](../observability.md#what-is-not-wired-for-you)).
You come here from a sender that says its posts fail, a route that sends nothing, or a load balancer that shows 5xx or 429
on the ingest's host name. The cases: [a secret or token to rotate](#rotate-a-sources-secret-or-token), [a flood](#a-flood-429-for-everyone),
[the ingest is down](#the-ingest-is-down-503-or-no-answer), [a provider whose posts are refused](#a-provider-whose-posts-are-refused)
and [a route that sends nothing](#a-route-that-sends-nothing).

**What is safe.** The ingest holds no job state and never calls a destination: stopping it, scaling it or restarting it loses
nothing that was stored, and a sender that gets `429` or `503` is told to retry (`Retry-After`). A request that was answered
`200` is in Postgres and its events are made; the tick sends them. Every call below is an operator call
([index](README.md#before-you-start)), and none returns a source's token or secret except the ones that make a new one, once.

## Rotate a source's secret or token

Rotate when a secret or a URL leaked, was pasted into a ticket, or someone who knew it left. A token is in the URL, so it is
also in any access log of the load balancer or the platform ([known issues](../known-issues.md), row 12).

```bash
# The secret: the old one keeps verifying for 24 hours, so the sender can change over without a gap.
curl -s -X POST -H "Authorization: Bearer $TOKEN" "$API/sources/$SOURCE/rotate-secret"
# The URL: the old one stops at once, so change the sender in the same minute.
curl -s -X POST -H "Authorization: Bearer $TOKEN" "$API/sources/$SOURCE/rotate-token"
```

Each answer holds the new value **once**. Put it into the sender's configuration at once and do not paste it into a ticket or
a log. The panel does the same on Gateway, Sources. A source that verifies needs `QCLOUD_WEBHOOK_KEY` on the ingest and the
Control API (`409 webhook_key_missing` otherwise). A source's verification kind cannot change: make another source, move the
routes to it (`PATCH /webhooks/{id}` with `source`) and remove the old one.

Confirm: `GET /requests?source=$SOURCE&limit=5` shows `accepted` requests received after the change, and no new `rejected`
ones with cause `verification failed`.

## A flood: 429 for everyone

Seen as `429` with `Retry-After` from the ingest for senders that were fine a minute ago. The ingest counts every request
against its global rate before it looks the token up (default 6,000 a minute per process), so random tokens use it up and a real
sender is refused until the minute ends: measured in [limits.md](../limits.md#15-the-public-ingest-tasks-07-to-10).

1. Look at the load balancer's request counts for the ingest's host: a rise of `404` beside `429` is a flood of tokens that do
   not exist. A rise of `429` on one path is a sender (or someone who holds its token) over that source's rate.
2. Find the source: `GET /sources` lists `rejectedDropped` for each, and `GET /requests?status=rejected` shows what was stored.
3. Fix, in this order of effort:
   - **A flood of unknown tokens:** block the address range at the edge (Cloud Armor on GCP, the WAF on AWS: the rules are in
     `infra/`, `edge.ingest_rate_limit_per_minute` on GCP and `ingest.rate_limit_per_minute` on AWS). The ingest only sees the load balancer's address.
   - **A source that is being hammered by someone with its token:** rotate the token ([above](#rotate-a-sources-secret-or-token)),
     or turn the source off (`PATCH /sources/$SOURCE` with `{"enabled": false}`; its URL then answers `404`).
   - **Real traffic above the rates:** raise `QCLOUD_INGEST_RATE_PER_SOURCE` or `QCLOUD_INGEST_RATE_GLOBAL`, or run more instances
     (each counts its own minute). More instances count as control processes in the connection budget:
     [connection exhaustion](connection-exhaustion.md).

Do not lower the body cap or the rates to stop a flood: they are the defence, and a flood of tokens is stopped by the edge.

## The ingest is down: 503 or no answer

`503` with `Retry-After: 5` means the process is up and the database is not (or is out of connections). No answer or a `502`
from the load balancer means the process is not up.

1. `GET /deployment` on the Control API and the [connection budget](connection-exhaustion.md): the ingest holds `ingest.pool_size`
   (2) connections an instance. A database failover or restart shows as `lookup failed` / `accept failed` in the ingest's log,
   at most once in ten seconds, with the error's name and nothing else.
2. A process that is not up: read its log. Exit code `2` is a configuration error, and the message names the setting but never
   its value (`QCLOUD_DATABASE_URL`, a `QCLOUD_INGEST_*` out of range, `QCLOUD_INGEST_HOST` left at the loopback default behind a
   load balancer). Exit `1` is a failure while running. On GCP: `gcloud run services logs read <name>-ingest --region REGION`; on AWS
   the `ingest` log group.
3. The schema must be migrated by the Control API's release step (`qcloud-api migrate`) before an ingest of this release takes
   posts. The ingest does not check the schema at start: against an older one it starts, and every post answers `503` and logs
   `lookup failed` until the migration has run.
4. Senders retry `429` and `503` themselves. A sender that does not will have lost the post: compare the sender's own log with
   `GET /requests` after the ingest is back.

## A provider whose posts are refused

The sender says its posts fail, or `GET /requests?source=$SOURCE&status=rejected` lists them. The cause is on each request:

| `cause` / the sender's status | What it means and the fix |
| --- | --- |
| `404` to the sender, nothing stored | The path is not a token path, the token is wrong, the source is off, or it was removed. They answer alike. Check `GET /sources` for the source and its `enabled`; rotate if the URL is unknown. |
| `verification failed` (401) | The secret, the header name or the user is wrong, or the provider signs something other than the raw body. A generic HMAC checks SHA-256 over the raw body, as hex or base64, with an optional `sha256=` prefix; a provider that signs a timestamp with the body (Stripe's format) does not fit, and there is no preset ([event-gateway.md](../event-gateway.md#sources)). Open a rejected request in the panel: the headers are kept, the credential ones as `[redacted]`. |
| `body too large` (413) | The body is above the cap (256 KB). The ingest cannot be set higher; the sender must send less. |
| `body not received in time` (408) | The sender was slower than `QCLOUD_INGEST_READ_TIMEOUT_MS` (10 s) to deliver its body. |
| `405` to the sender | The method is not `POST`, `PUT`, `PATCH` or `DELETE`. |
| `400` to the sender | The `Content-Type` header is longer than 255 characters. |

A rejected request keeps no body, so it cannot be replayed (`409`); ask the provider to send it again.

## A route that sends nothing

A route sends only what arrives while it is on, from the source it listens to.

1. `GET /webhooks/$ID`: `source` is `null` (the panel says **This connection needs a source**) when the route listened to a queue's
   job events, which migration 21 removed ([upgrading](../event-gateway.md#upgrading)). It is off with that reason. Pick a source
   (`PATCH /webhooks/$ID` with `{"source": "<id>"}`), then enable it (`PUT /webhooks/$ID/enabled`).
2. `enabled` is `false` or `pausedBy` is set: a route paused for failures stays paused after its address is fixed. Resume it
   ([webhooks.md](../webhooks.md#pausing-a-webhook-hold-or-ignore)).
3. The request arrived and made no event: `GET /requests/$REQUEST` lists the events it made. A `filter` that does not match, a
   `dedupe` key already seen in its window, or a route that was off when the request arrived makes none. The panel's connection
   page has the preview (`POST /webhooks/preview`) for a filter and a shape on a made-up request.
4. An event exists and fails: [the Events tab](../event-gateway.md#in-the-panel) shows the attempts. A request that arrived while
   the route was off is not replayed by turning the route on; replay the stored request
   (`POST /requests/$REQUEST/replay`, an operator call that makes new events).

## Verify

A post to the source's URL answers `200 {"id":"…"}` and `GET /requests/$ID` shows it `accepted`, with the events it made. The
sender's next post is accepted, and the load balancer's `429` and `5xx` counts are back to normal.

## When to stop and ask

- The flood is not stopped by the edge rule, or the edge has no per-address rule on this deployment: this is the owner's
  decision (`terraform apply` changes the edge).
- Posts you cannot account for appear on a source whose token you never shared: treat it as a leaked URL, rotate it, and look at
  who can read the access logs.
