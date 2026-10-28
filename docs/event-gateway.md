# Event gateway

The event gateway takes what is posted to it and sends it on: to a URL of yours, or to another queue. Post
`{ "id": 500, "name": "chris" }` and, with no rules on the route, the destination gets `{ "id": 500, "name": "chris" }`. A route
can first drop requests it does not want (`filter`), rewrite the body (`shape`) or wait (`delayMs`). It is the
[webhook](webhooks.md) system with a source of its own and a second kind of destination.
Written for the operator who sets routes up and the engineer who decides what should happen "when A is posted".

The design is [DESIGN.md section 6](../DESIGN.md) (D11, D12, D13 and D14). The panel's reference was
[Hookdeck](https://hookdeck.com/docs); the words are borrowed where they fit and the product is not a copy of it.

## The model

A **route** (a connection, in the panel) is one row of `qcloud_webhooks`: a source, rules and a destination.

| Part | What it is |
| --- | --- |
| Source | One [inbound source](#sources). Every request it accepts is offered to each of its enabled routes. A route has exactly one, and one is needed to turn it on. |
| Rules | `filter` (send fewer requests), de-duplication (`dedupe`), `shape` (the body), `delayMs` (send later), `schedule` (hold events until a cron fires, such as midnight each night), `batch` (send the due events as one request), a rate of 60 attempts a minute, the retry schedule and auto-pause after repeated failures. A request meets them in that order. All as in [webhooks.md](webhooks.md); all declarative data, **no code runs**. |
| Destination | `http`: a request to a URL of yours. `queue`: one job added to a queue of the same namespace. Either can be a **saved destination** that several connections share ([below](#saved-destinations)). |
| Name | An optional `name` (80 characters) and `description` (500). They change nothing about delivery. |

What happens to one request is the same for both kinds. The request is stored, each route that accepts it gets an **event**
(a delivery row) in the same transaction, and the sender makes **attempts** at it until one succeeds or the schedule runs
out. The panel says Events, Attempts and Connections where the API says deliveries, history and webhooks. Routes, fields and
tables keep their API names.

### `http` destination

Exactly the webhook of [webhooks.md](webhooks.md): `https:` only, signed with the secret, retried on a 5xx, a timeout or
a refusal. That page stays the reference for the request, the signature and where a URL may point.

### `queue` destination: "when A happens, do B"

A `queue` route adds one job to its target queue through the store's own enqueue, so pause, the rate limit, queue limits
and de-duplication apply to it as to any producer. It has no URL and no secret, and no network is involved. Nothing is signed: a `queue` route is never given a secret, a `secret` on one is refused
(`400 unsupported_option`) and so is rotating one.

- The job's `name` is the event's name (`request.received`; `webhook.test` for a test). Its `data` is the body the route's
  `shape` makes, or the request's body: the parsed JSON, or the text for a body that is not JSON.
- It carries what was posted and nothing else.
- The job's id is `qcloud-route-<delivery id>`. If an attempt repeats (a lapsed claim) while that job is still waiting
  or running, it finds the job and adds no second. If the job had already **finished**, the repeat adds it again, so a
  handler must be idempotent ([known-issues.md](known-issues.md), row 14). The panel shows the id as the event's result.
- A store refusal (a full group, a queue limit) is a failed attempt and follows the route's retry schedule like a 5xx.
- The job gets no doorbell from the route; the tick's re-ring pass rings it within one interval, as it does for a cron job.

**Worked example: when a payment fails, refund it.**

1. Make a source `payments` and give its URL to the payment provider.
2. Create a route from that source to **Another queue**, `refunds`, with the filter `{ "body.status": "failed" }`.
3. A worker of `refunds` handles jobs named `request.received` and reads `data.orderId` to look the order up.
4. A failed payment now adds one `refunds` job. Any other request is stored and makes nothing: **no route, no effect**.

"Start a workflow" is the same route. The Control API and the tick hold no workflow definitions, so the `refunds`
worker calls `startWorkflow(name, data)` itself (DESIGN section 8). There is no built-in "start this workflow" job.

### No route, no effect, and no loop

A request that no enabled route accepts is stored and does nothing. A job that a route adds is a job like any other, but
it makes **no event**: only an inbound request does. So routes cannot feed one another, and no route can loop, which is why
there is no loop check and no limit on a chain.

## Sources

A **source** is a URL that takes requests. A third party (Stripe, a form, an internal service) posts to it; Qelay stores the
request and offers it to the source's routes. The Control API makes and edits sources (`/sources`) and reads the stored
**requests** (`/requests`); the public address belongs to the separate ingest service, which stores and answers and never
calls a destination.

- **The URL** is the ingest's origin and `/s/<token>`. The token and, for a source that verifies, the secret appear **once**,
  in the response that made them, and in no read, log or audit entry. A lost token or secret is replaced with
  `POST /sources/{id}/rotate-token` or `POST /sources/{id}/rotate-secret`.
- **Verification** is chosen when the source is made and cannot change: `none` (anyone with the URL can post), `hmac` (a
  signature in a header), `basic` (a user name and the secret as the password) or `api_key` (the secret in a header). A
  source that verifies needs the deployment's `QCLOUD_WEBHOOK_KEY` (`409 webhook_key_missing`). There is no preset for a
  provider: a generic HMAC covers Stripe, GitHub and the like.
- **What is stored** for a request: the method, the query, the headers and the body, up to 256 KB. The credential headers
  (`authorization`, `cookie`, `proxy-authorization`, `set-cookie` and the source's own verification header) are kept as
  `[redacted]`. A request that fails a check is stored as `rejected` with its cause, up to a cap per source per minute, so a
  flood cannot fill the table. A viewer reads a request's headers and query but not its body.
- **A name is unique** in the namespace (`409 source_name_taken`), at most **100** are kept (`409 source_limit`), and a source
  that routes still listen to cannot be deleted (`409 source_in_use`).
- **Replay.** `POST /requests/{id}/replay` offers a stored request to its source's routes as they are now, skipping
  de-duplication, and makes new events. It is for an operator.

### The public address

The ingest (`packages/ingest`, one process on `Bun.serve`, any number side by side) takes the post. It checks the source's
verification, stores the request and answers; the tick delivers, and the ingest never calls out. Only `GET /healthz`
(`{"ok":true}`, no database) is open; everything else is `/s/qin_` plus 43 characters. In this order, and a step that refuses
ends the request:

| Case | Answer |
| --- | --- |
| Path is not a token path | `404` |
| Method is not `POST`, `PUT`, `PATCH` or `DELETE` | `405`, `Allow` set |
| Over the process's rate, before any lookup | `429`, `Retry-After` |
| Token unknown, source off or deleted | `404`, one answer for all three |
| Over the source's rate | `429`, nothing stored |
| Body over the cap, declared or streamed | `413`, stored as a rejection |
| Body not delivered in time | `408`, stored as a rejection |
| Verification fails | `401`, stored as a rejection |
| Database unreachable | `503`, `Retry-After: 5`; a sender retries |
| Otherwise | `200 {"id":"…"}`: stored, and one event made for each enabled route |

The settings are `QCLOUD_INGEST_MAX_BODY_BYTES` (256 KB, the most), `QCLOUD_INGEST_READ_TIMEOUT_MS` (10 s),
`QCLOUD_INGEST_RATE_PER_SOURCE` (600 a minute) and `QCLOUD_INGEST_RATE_GLOBAL` (6,000 a minute); see
[configuration](reference/configuration.md#ingest). The rates are counted **per process** in a fixed minute, so `n`
instances let through about `n` times the figure. Per-address limiting belongs at the edge, and the Terraform and the chart
say where ([limits.md](limits.md), [known issues](known-issues.md), row 12). A route with no shape sends the request's
bytes and content type unchanged: post `{"id":500,"name":"chris"}` and that is what the destination gets.

A rule reads the request as one document, `{ method, headers, query, body }`, by a dotted path: `body.id`,
`headers.x-github-event`, `query.page`. `body` exists when the request was JSON; a body that is not JSON is passed through
whole and cannot be addressed. [webhooks.md](webhooks.md#filters-and-shapes) has the grammar.

## Saved destinations

A destination can be saved once, with a name, and picked by several connections (`POST /webhooks/destinations`, then
`destinationId` on `POST /webhooks`). Saving one adds no new kind of route: each connection **keeps its own copy** of the
address or target, so the sender and every read work as before, and a connection made without one is the
same row as ever.

- **Editing an address rewrites every copy** in one transaction.
  A connection that was paused for failures stays paused: change the address, then resume it.
- **A destination in use cannot be removed**: `409 destination_in_use`, with the number of connections in `details`.
- At most **100** per namespace (`409 destination_limit`); a name is unique (`409 destination_name_taken`); an unknown id is
  `404 destination_not_found`.
- The kind (`http` or `queue`) is fixed when it is saved. A destination holds **no secret**: a signing secret belongs to a
  connection. A viewer sees only the address's origin (`urlRedacted`).
- `destinationId` cannot be combined with `url`, `target` or `destination` on create (`400`). A connection cannot be
  detached from its destination: remove it and add it again.

## In the panel

**Event gateway** (Automation, operators only; the item is left out when the deployment has no webhooks) has seven tabs:

| Tab | Shows |
| --- | --- |
| Connections | Every connection under the source it listens to, as a **Structured** list or a **Table**, each with its name, its last 24 hours as a small trend and its failure rate (one grouped read for the whole list). Search by text and filter by state (on, paused, off); the view and filters are in the address, so a list can be bookmarked. A chip marks a connection with a filter, a shape, a delay or de-duplication. Turn one on or off, send a test event, remove it, or press **New connection**. |
| Sources | The sources, each with its state, how it verifies and how many connections listen to it. Make one (a name and how it verifies), rotate its token or secret, turn it off or remove it. The address (`/s/<token>`) and the secret are shown **once**, in the page's state until **Done**, and are in no address, storage or message. The panel does not know the ingest's origin, so it shows the path and says to post it to the ingest address. |
| Requests | Every stored request, newest first, filtered by status and source (kept in the address) and paged with **Newer** and **Older**. Open one for its headers, query, body (a viewer gets none), the events it made and **Replay**, which asks first. |
| Events | Every event, newest first. Filter by status, connection, time, HTTP code and text. Open one to see its attempts. Retry one, or **Retry all failed** for a connection. A strip above the list shows when the events happened, for the same connection and time range. **Refresh** reads the list and the strip now. **Save view** keeps the connection, status and time range under a name, in this browser only (at most 20); pick one to apply it. |
| Metrics | Successful, failed, failure rate, attempts per event, waiting now and receiver speed for one connection or all, with two charts. |
| Issues | One issue per connection whose events keep failing, in four tabs by status: **Open**, **Acknowledged**, **Resolved**, **Ignored**. A connection whose last settled event failed has one live issue; it resolves itself when an event is delivered, and an operator can acknowledge it, ignore it (the deployment warnings stop counting the connection until it is delivered to again; the panel's Home list still names a paused or failing connection, [known issues](known-issues.md), row 13), resolve it by hand or reopen it (`updatedBy` is empty when Qelay did it). Resolved issues are kept as long as finished events (2 days by default). Against a server that keeps no issues, the tab shows the paused and failing connections instead. |
| Destinations | The saved destinations, with how many connections use each: add one, edit its address (every connection that uses it follows) or remove one that no connection uses. |

A connection with no source is off and says **This connection needs a source**; pick one on its page, then enable it.

A connection has a page of its own, `/events-gateway/connections/<id>`, with three tabs:

- **Overview**: the source, destination, rules and counts, the id, and the last 24 hours.
- **Metrics**: the Metrics tab for this connection alone.
- **Settings**: an editable form for the name, description, filter, shape, delay and de-duplication (it shows the
  request **Save** will send; a save sends only what changed, and a refusal stays beside the field it is about). Below it the
  rules every connection shares, in order (rate limit, retry, auto-pause) and what is on for this one, then the signing
  secret, **Pause**, **Disable** and **Remove**. A viewer sees the same rules read-only. The destination is fixed: to change
  it, add a new connection and remove this one (or edit the saved destination). The rate, retry and
  pause numbers are the [documented defaults](webhooks.md); a deployment that changed them is not reflected. There are two
  ways to stop a connection: **Pause** holds (events are still collected and **Resume** sends them) and **Disable**
  ignores (events that happen meanwhile are never collected, and **Enable** sends nothing from the time it was off;
  [hold and ignore](webhooks.md#pausing-a-webhook-hold-or-ignore)).
  **Rotate secret** (**Create secret** for an unsigned connection) shows the new secret once, with a copy button, and
  keeps it on the page only: it is not in the address, in storage or in a message. The old secret keeps signing for 24
  hours ([rotating the secret](webhooks.md#rotating-the-secret)). A deployment with no signing key says so.

**New connection** is a page, `/events-gateway/connections/new`, with four steps: Source (a **Source picker**), Destination (an address,
another queue or, when any are saved, a **Saved destination**), Rules (a name and description, the filter, shape, delay and
de-duplication and, for an address, the signing secret) and Save. A refusal stays on the page,
at the step it belongs to, with what was typed kept. Saving opens the new connection. When no secret was typed and the
deployment has a signing key, the store makes one: the page then shows it once, with a copy button, and waits for **Open
connection**. It is kept in the page's state only, as for a rotation.

Home shows the gateway's 24-hour failure rate and lists a paused or failing route among the things that need attention.

## API

The routes are the webhook routes. `POST /webhooks` takes `source` (required), `destination` (`http`, the default, or `queue`) and `target`
(the queue, for a `queue` route), or `destinationId` for a saved destination, and the optional `name`, `description`,
`filter`, `shape`, `delayMs` and `dedupe`. Reads carry `source`, `destination`, `destinationId`, `target`, `name`, `description`, `delayMs`, `dedupe`,
`consecutiveFailures`, `alertLevel`, `disabledReason`, `disabledAt` and `pausedBy`. The event feed, the counts, the issues
and the destinations are:

| Route | Does |
| --- | --- |
| `GET`, `POST /sources` | Lists or makes sources. A create answers once with the URL token and, for a source that verifies, the secret. |
| `GET`, `PATCH`, `DELETE /sources/{id}` | Reads, renames or removes a source; a source that routes listen to cannot be removed. |
| `POST /sources/{id}/rotate-token`, `POST /sources/{id}/rotate-secret` | Replaces the URL token or the secret and shows the new one once. |
| `GET /requests`, `GET /requests/{id}` | Stored requests, newest first, filtered by source and status and paged by keyset; one request with the events it made. |
| `POST /requests/{id}/replay` | Offers a stored request to its source's routes again. |
| `PATCH /webhooks/{id}` | Changes the name, description, source, filter, shape, delay and de-duplication; an absent key is left alone and `null` clears one. The destination and secret are not editable. |
| `GET /webhooks/deliveries` | Events of every route, newest first, filtered by `status`, `webhook`, `since`, `until`, paged by `before`. |
| `GET /webhooks/stats` | Counts, failure ratio, attempts per event, the backlog and (HTTP) latency per time slice, over a window of at most 7 days. With `groupBy=webhook`, one entry per route (counts, ratio, backlog and a trend, no latency) in one read. |
| `GET /webhooks/issues` | Issues, newest first, filtered by `status` and `webhook`, paged by `before` (50 by default, at most 200); the answer also holds the count in each status. |
| `PUT /webhooks/issues/{id}` | Sets an issue to `acknowledged`, `ignored`, `resolved` or `open`. A resolved issue is history: `409 issue_resolved`, and the connection's next failure opens a new one. An unknown id is `404 issue_not_found`. |
| `GET`, `POST /webhooks/destinations` | Lists or saves destinations. |
| `PATCH`, `DELETE /webhooks/destinations/{id}` | Renames or re-addresses one (every connection's copy follows), or removes one no connection uses. |
| `POST /webhooks/preview` | Tries a filter and a shape on a made-up request (`method`, `headers`, `query`, `body`) and answers what would be sent. Nothing is saved or sent. |
| `POST /webhooks/{id}/deliveries/retry` | Puts a route's failed events back, newest first, at most **500** a call, each with a full budget of attempts. |
| `POST /webhooks/{id}/test` | Queues a `webhook.test` event for the route (a `queue` route adds a job of that name). |
| `PUT /webhooks/{id}/enabled` | Pauses or resumes. `{"enabled": false, "mode": "hold"}` holds, the default `ignore` disables ([webhooks.md](webhooks.md#pausing-a-webhook-hold-or-ignore)). |

Every call that changes a route is an `operator` call and leaves an audit row naming the route's id and nothing else.
[openapi.yaml](openapi.yaml) is the contract.

## Upgrading

Migrations 16 to 19 only add columns and tables (`destination` and `target`; `name`, `description`, `delay_ms`, `dedupe`;
issues; saved destinations), so a release that predates them keeps reading and writing everything. A sender that predates
16 cannot send a `queue` route: it fails each event of it without a request, on the route's retry schedule, and enough
failures in a row **pause the route** (auto-pause). Add the first `queue` route after every tick runs the new release.

**Migration 21 removes the job events, and it is not safe with an older release connected.** Nothing in 1.0.0 had been
released when the owner decided it (D14), so it is one forward migration and not the two-release removal that CLAUDE.md asks of
a shipped release. It drops the trigger and the delivery writer, drops a route's `events`, `queue` and `active_from`, and
lets a delivery have no job. Roll every worker and tick to this release first, then migrate. What it does to the data:

- **A route that listened to a queue is kept, turned off,** with the reason "its source, a queue's job events, was removed".
  Nothing is deleted. To use it again, pick a source for it and enable it.
- **An event that had not been sent** for such a route fails with the same reason. Delivered and failed events stay readable.

Rolling back the release leaves the new schema in place and unread. A migration that has shipped is never edited
([operations.md](operations.md)).

## Not built

Each is its own decision, and none is hidden by the panel. Those marked "needs" cannot be built in the panel alone:

- **A source's origin in the panel, and its last request.** The Control API does not know the ingest's address, so the panel
  shows `/s/<token>`; a source row has no "last request" (it would be a new field on the wire). Its Requests link filters the log.
- **Renaming a source,** and the repair for a connection with no source from the list (it is on the connection page only).
- **Detaching a connection from its saved destination**, and changing the destination of a connection to another one.
  Remove the connection and add it again.
- **JavaScript transforms.** `shape` rewrites the body declaratively and is editable; user code would be a new trust
  boundary and is a separate decision. The panel does not call `POST /webhooks/preview`, so there is no try-it panel for a
  filter or a shape yet.
- **Replay of a request to another source**, delivery groups and a CLI destination.
- **Resetting a paused connection when its destination changes.** A connection paused for failures stays paused after its
  address is fixed: resume it.
- **A timeline bar as a link.** The strip on Events shows when events happened; narrowing the list to one bar needs a `from`
  and `to` in the address, which the panel does not take yet.
- **Pagination of Connections and Issues.** A namespace has at most 100 routes. The Issues tab shows the newest 200 of a
  status and says so; the API pages them with `before`.

Limits and costs are in [limits.md](limits.md#12-webhooks-task-52).
