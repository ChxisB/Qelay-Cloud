# Event gateway

The event gateway sends what happens to jobs somewhere else: to a URL of yours, or to another queue. It is the
[webhook](webhooks.md) system with a second kind of destination, and it keeps every webhook as it was.
Written for the operator who sets routes up and the engineer who decides what should happen "when A happens".

The design is [DESIGN.md section 6](../DESIGN.md) (D11). The panel's reference was [Hookdeck](https://hookdeck.com/docs);
the words are borrowed where they fit and the product is not a copy of it.

## The model

A **route** (a connection, in the panel) is one row of `qcloud_webhooks`, so every webhook registered before the event
gateway is a route with an `http` destination and nothing changed for it.

| Part | What it is |
| --- | --- |
| Source | The job events of **one queue** (or, for an `http` route only, every queue). The events are `job.pushed`, `job.started`, `job.completed`, `job.failed` and `job.progress`. |
| Rules | `filter` (send fewer events), de-duplication (`dedupe`), `shape` (the body), `delayMs` (send later), a rate of 60 attempts a minute, the retry schedule and auto-pause after repeated failures. An event meets them in that order. All as in [webhooks.md](webhooks.md); all declarative data, **no code runs**. |
| Destination | `http`: a request to a URL of yours. `queue`: one job added to a queue of the same namespace. Either can be a **saved destination** that several connections share ([below](#saved-destinations)). |
| Name | An optional `name` (80 characters) and `description` (500). They change nothing about delivery. |

What happens to one event is the same for both kinds. The matching job event makes an **event** (a delivery row), and
the sender makes **attempts** at it until one succeeds or the schedule runs out. The panel says Events, Attempts and
Connections where the API says deliveries, history and webhooks. Routes, fields and tables keep their API names.

### `http` destination

Exactly the webhook of [webhooks.md](webhooks.md): `https:` only, signed with the secret, retried on a 5xx, a timeout or
a refusal. That page stays the reference for the request, the signature and where a URL may point.

### `queue` destination: "when A happens, do B"

A `queue` route adds one job to its target queue through the store's own enqueue, so pause, the rate limit, queue limits
and de-duplication apply to it as to any producer. It has no URL and no secret, and no network is involved. Nothing is signed: a `queue` route is never given a secret, a `secret` on one is refused
(`400 unsupported_option`) and so is rotating one.

- The job's `name` is the event's name (`job.failed`). Its `data` is the body the route's `shape` makes, or the default
  body (`id`, `event`, `timestamp`, `queue`, `jobId`, and `state`, `error`, `progress` when known).
- It carries the seven fields of the event, **not the failed job's own data or result**: a worker that needs them asks
  by the job id, as a webhook receiver does.
- The job's id is `qcloud-route-<delivery id>`. If an attempt repeats (a lapsed claim) while that job is still waiting
  or running, it finds the job and adds no second. If the job had already **finished**, the repeat adds it again, so a
  handler must be idempotent ([known-issues.md](known-issues.md), row 14). The panel shows the id as the event's result.
- A store refusal (a full group, a queue limit) is a failed attempt and follows the route's retry schedule like a 5xx.
- The job gets no doorbell from the route; the tick's re-ring pass rings it within one interval, as it does for a cron job.

**Worked example: when an order fails, refund it.**

1. Create a route: from queue `orders`, event `job.failed`, destination **Another queue**, to `refunds`.
2. A worker of `refunds` handles jobs named `job.failed`, and reads `data.jobId` to look the order up.
3. A failed `orders` job now adds one `refunds` job. A completed one adds nothing: **no route, no effect**.

"Start a workflow" is the same route. The Control API and the tick hold no workflow definitions, so the `refunds`
worker calls `startWorkflow(name, data)` itself (DESIGN section 8). There is no built-in "start this workflow" job.

### No route, no effect

An event that matches no enabled route does nothing, so nothing is chained unless someone opted in. A job that a route
adds is a job like any other, so its own events can match the next route: a **chain** is routes feeding routes.

## Loops are refused when a route is saved

A route from queue A to queue B is an edge. Saving a route reads every route of the namespace (enabled or not) and answers:

| Answer | When |
| --- | --- |
| `409 route_cycle` | The new edge would close a loop (A to B to A, or a queue to itself). |
| `409 route_chain_too_long`, `details.limit` 5 | The longest chain of routes would pass **5** hops. |
| `400 unsupported_option` | A `queue` route has no source queue (an all-queues source would match the events of its own destination's jobs), no `target`, or a `url`; or an `http` route has a `target`. |

The check runs on create, when the queue or the destination changes, and when a route is **enabled**, so a route that was
safe when it was disabled cannot be turned on into a loop. Saves of the namespace's routes are serialised with a
transaction-level advisory lock, so two saves cannot close a loop between them.

There is **no run-time depth counter**. A job that a worker's own code adds (not a route) is not a hop and is not counted:
a worker that enqueues into its own queue is the worker's business.

## Saved destinations

A destination can be saved once, with a name, and picked by several connections (`POST /webhooks/destinations`, then
`destinationId` on `POST /webhooks`). Saving one adds no new kind of route: each connection **keeps its own copy** of the
address or target, so the sender, the loop check and every read work as before, and a connection made without one is the
same row as ever.

- **Editing an address rewrites every copy** in one transaction. A new queue address that would close a loop for any of
  its connections is `409 route_cycle`, and one that would pass 5 hops is `409 route_chain_too_long`; nothing changes.
  A connection that was paused for failures stays paused: change the address, then resume it.
- **A destination in use cannot be removed**: `409 destination_in_use`, with the number of connections in `details`.
- At most **100** per namespace (`409 destination_limit`); a name is unique (`409 destination_name_taken`); an unknown id is
  `404 destination_not_found`.
- The kind (`http` or `queue`) is fixed when it is saved. A destination holds **no secret**: a signing secret belongs to a
  connection. A viewer sees only the address's origin (`urlRedacted`).
- `destinationId` cannot be combined with `url`, `target` or `destination` on create (`400`). A connection cannot be
  detached from its destination: remove it and add it again.

## In the panel

**Event gateway** (Automation, operators only; the item is left out when the deployment has no webhooks) has five tabs:

| Tab | Shows |
| --- | --- |
| Connections | Every connection under the source it listens to, as a **Structured** list or a **Table**, each with its name, its last 24 hours as a small trend and its failure rate (one grouped read for the whole list). Search by text and filter by state (on, paused, off); the view and filters are in the address, so a list can be bookmarked. A chip marks a connection with a filter, a shape, a delay or de-duplication. Turn one on or off, send a test event, remove it, or press **New connection**. |
| Events | Every event, newest first. Filter by status, connection, time, HTTP code and text. Open one to see its attempts. Retry one, or **Retry all failed** for a connection. A strip above the list shows when the events happened, for the same connection and time range. **Refresh** reads the list and the strip now. **Save view** keeps the connection, status and time range under a name, in this browser only (at most 20); pick one to apply it. |
| Metrics | Successful, failed, failure rate, attempts per event, waiting now and receiver speed for one connection or all, with two charts. |
| Issues | One issue per connection whose events keep failing, in four tabs by status: **Open**, **Acknowledged**, **Resolved**, **Ignored**. A connection whose last settled event failed has one live issue; it resolves itself when an event is delivered, and an operator can acknowledge it, ignore it (the deployment warnings stop counting the connection until it is delivered to again; the panel's Home list still names a paused or failing connection, [known issues](known-issues.md), row 13), resolve it by hand or reopen it (`updatedBy` is empty when Qelay did it). Resolved issues are kept as long as finished events (2 days by default). Against a server that keeps no issues, the tab shows the paused and failing connections instead. |
| Destinations | The saved destinations, with how many connections use each: add one, edit its address (every connection that uses it follows) or remove one that no connection uses. |

A connection has a page of its own, `/events-gateway/connections/<id>`, with three tabs:

- **Overview**: the source, destination, events, rules and counts, the id, and the last 24 hours.
- **Metrics**: the Metrics tab for this connection alone.
- **Settings**: an editable form for the name, description, events, filter, shape, delay and de-duplication (it shows the
  request **Save** will send; a save sends only what changed, and a refusal stays beside the field it is about). Below it the
  rules every connection shares, in order (rate limit, retry, auto-pause) and what is on for this one, then the signing
  secret, **Pause**, **Disable** and **Remove**. A viewer sees the same rules read-only. The source queue and the destination
  are fixed: to change one, add a new connection and remove this one (or edit the saved destination). The rate, retry and
  pause numbers are the [documented defaults](webhooks.md); a deployment that changed them is not reflected. There are two
  ways to stop a connection: **Pause** holds (events are still collected and **Resume** sends them) and **Disable**
  ignores (events that happen meanwhile are never collected, and **Enable** sends nothing from the time it was off;
  [hold and ignore](webhooks.md#pausing-a-webhook-hold-or-ignore)).
  **Rotate secret** (**Create secret** for an unsigned connection) shows the new secret once, with a copy button, and
  keeps it on the page only: it is not in the address, in storage or in a message. The old secret keeps signing for 24
  hours ([rotating the secret](webhooks.md#rotating-the-secret)). A deployment with no signing key says so.

**New connection** is a page, `/events-gateway/connections/new`, with four steps: Source (the queue), Destination (an address,
another queue or, when any are saved, a **Saved destination**), Rules (a name and description, the events to send, the
filter, shape, delay and de-duplication and, for an address, the signing secret) and Save. A refusal stays on the page,
at the step it belongs to, with what was typed kept. Saving opens the new connection. When no secret was typed and the
deployment has a signing key, the store makes one: the page then shows it once, with a copy button, and waits for **Open
connection**. It is kept in the page's state only, as for a rotation.

Home shows the gateway's 24-hour failure rate and lists a paused or failing route among the things that need attention.

## API

The routes are the webhook routes. `POST /webhooks` takes `destination` (`http`, the default, or `queue`) and `target`
(the queue, for a `queue` route), or `destinationId` for a saved destination, and the optional `name`, `description`,
`delayMs` and `dedupe`. Reads carry `destination`, `destinationId`, `target`, `name`, `description`, `delayMs`, `dedupe`,
`consecutiveFailures`, `alertLevel`, `disabledReason`, `disabledAt` and `pausedBy`. The event feed, the counts, the issues
and the destinations are:

| Route | Does |
| --- | --- |
| `PATCH /webhooks/{id}` | Changes the name, description, events, filter, shape, delay and de-duplication; an absent key is left alone and `null` clears one. The source, destination and secret are not editable. |
| `GET /webhooks/deliveries` | Events of every route, newest first, filtered by `status`, `webhook`, `since`, `until`, paged by `before`. |
| `GET /webhooks/stats` | Counts, failure ratio, attempts per event, the backlog and (HTTP) latency per time slice, over a window of at most 7 days. With `groupBy=webhook`, one entry per route (counts, ratio, backlog and a trend, no latency) in one read. |
| `GET /webhooks/issues` | Issues, newest first, filtered by `status` and `webhook`, paged by `before` (50 by default, at most 200); the answer also holds the count in each status. |
| `PUT /webhooks/issues/{id}` | Sets an issue to `acknowledged`, `ignored`, `resolved` or `open`. A resolved issue is history: `409 issue_resolved`, and the connection's next failure opens a new one. An unknown id is `404 issue_not_found`. |
| `GET`, `POST /webhooks/destinations` | Lists or saves destinations. |
| `PATCH`, `DELETE /webhooks/destinations/{id}` | Renames or re-addresses one (every connection's copy follows), or removes one no connection uses. |
| `POST /webhooks/preview` | Tries a filter and a shape on a made-up event and answers what would be sent. Nothing is saved or sent. |
| `POST /webhooks/{id}/deliveries/retry` | Puts a route's failed events back, newest first, at most **500** a call, each with a full budget of attempts. |
| `POST /webhooks/{id}/test` | Queues a `webhook.test` event for the route (a `queue` route adds a job of that name). |
| `PUT /webhooks/{id}/enabled` | Pauses or resumes. `{"enabled": false, "mode": "hold"}` holds, the default `ignore` disables ([webhooks.md](webhooks.md#pausing-a-webhook-hold-or-ignore)). |

Every call that changes a route is an `operator` call and leaves an audit row naming the route's id and nothing else.
[openapi.yaml](openapi.yaml) is the contract.

## Upgrading

Migration 16 only adds columns (`destination`, default `http`, and a nullable `target`), so old workers and ticks stay
connected. A sender that predates it cannot send a `queue` route: it fails each event of it without a request, on the
route's retry schedule, and enough failures in a row **pause the route** (auto-pause). **Add the first `queue` route after
every tick runs the new release.** If one was added early, resume it once every tick is upgraded: its failed events can be
retried with **Retry all failed**.

Migrations 17 to 19 are as safe: nullable or defaulted columns and new tables only, so a release that predates them keeps
reading and writing everything. What an older worker does not do, while it is the one working:

| Version | Adds | An older worker or tick |
| --- | --- | --- |
| 17 | `name`, `description`, `delay_ms`, `dedupe` and the `qcloud_webhook_dedupe` table | The sender still sends what it finds, a delay already in `next_attempt_at`. An older **writer** ignores a delay or a de-duplication, so **add the first connection with one after every tick runs this release.** |
| 18 | `qcloud_webhook_issues` | It records no issues: one can read open after its connection recovered, or be missing while it fails, until a worker of this release settles an event for that connection. Roll every worker before relying on the Issues tab. The migration opens an issue for each connection already failing or paused for failing. |
| 19 | `qcloud_webhook_destinations` and a nullable `destination_id` | It can neither make a connection from a saved destination nor rewrite its copies. Roll every worker before sharing a destination. |

Rolling back the release leaves the new columns and tables in place and unread. A migration that has shipped is never
edited ([operations.md](operations.md)).

## Not built

Each is its own decision, and none is hidden by the panel. Those marked "needs" cannot be built in the panel alone:

- **Inbound HTTP sources** (D12): a public URL that stores a request and fans it out to routes. Planned in
  `.claude/.planning/inbound-sources/`, **not started**, and it needs its own security review, rate limits and `infra/`.
- **Reusable sources.** A destination can be saved and shared ([above](#saved-destinations)); a source is still one queue.
  Reusable sources arrive with inbound sources, the only source with state of its own.
- **Detaching a connection from its saved destination**, and changing the destination of a connection to another one.
  Remove the connection and add it again.
- **JavaScript transforms.** `shape` rewrites the body declaratively and is editable; user code would be a new trust
  boundary and is a separate decision. The panel does not call `POST /webhooks/preview`, so there is no try-it panel for a
  filter or a shape yet.
- **Replay of a request**, delivery groups and a CLI destination.
- **Resetting a paused connection when its destination changes.** A connection paused for failures stays paused after its
  address is fixed: resume it.
- **A timeline bar as a link.** The strip on Events shows when events happened; narrowing the list to one bar needs a `from`
  and `to` in the address, which the panel does not take yet.
- **Pagination of Connections and Issues.** A namespace has at most 100 routes. The Issues tab shows the newest 200 of a
  status and says so; the API pages them with `before`.

Limits and costs are in [limits.md](limits.md#12-webhooks-task-52).
