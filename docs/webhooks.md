# Webhooks

An operator registers a URL and the job events it wants. Qelay-Cloud POSTs each matching event to it, **at least once**.
Written for two readers: the operator who sets webhooks up, and the engineer who writes the receiver.

A webhook is the `http` destination of an [event gateway](event-gateway.md) route. This page is the reference for that
destination: the request, the signature, retries and where a URL may point. A route can instead add a job to another
queue (`destination: "queue"`), which has no URL, no secret and none of the checks below.

What a webhook is not: a way to move job data (the body has none), an ordered stream (see
[What is not promised](#what-is-not-promised)) or a fan-out service (see [Volume](#volume)).

## Registering one

Panel: **Event gateway**, Connections (operators only). Control API: `POST /webhooks`, with the `operator` role; every call that changes a
webhook leaves one audit row naming `webhook=<id>` and nothing else (no URL, no secret).

| Field | Meaning |
| --- | --- |
| `url` | `https:` only (see [Where a webhook may point](#where-a-webhook-may-point)), at most 2,048 characters, no credentials in it |
| `events` | One or more of `job.pushed`, `job.started`, `job.completed`, `job.failed`, `job.progress` |
| `queue` | One queue name, or none for every queue. A list of queues is not offered: register one webhook per queue |
| `secret` | Optional, 16 to 256 characters. **Every delivery is signed** when the deployment has `QCLOUD_WEBHOOK_KEY`: with no `secret`, the service generates one (see [Rotating the secret](#rotating-the-secret)). Without the key a webhook has no secret and is sent unsigned (`signed: false`) |
| `filter` | Optional. Only events it lets through are sent. Needs the delivery writer on (see [Filters and shapes](#filters-and-shapes)) |
| `shape` | Optional. A template for the body. Needs the delivery writer on, as above |
| `delayMs` | Optional, 1,000 to 3,600,000 (1 second to 1 hour). Each delivery is due this long after its event. Needs the delivery writer on (see [Delay and de-duplication](#delay-and-de-duplication)) |
| `dedupe` | Optional. `{ windowMs, fields }`: drop repeats of an event inside a window. Needs the delivery writer on, as above |
| `name`, `description` | Optional, at most 80 and 500 characters. What the operator calls the webhook; they change nothing about delivery |
| `destinationId` | Optional. Takes the address from a [saved destination](event-gateway.md#saved-destinations) instead of `url`; it cannot be combined with `url` |

At most **100** webhooks per namespace. The Control API never returns a secret you gave, and no read returns any secret:
the one exception is a secret the service generated, which comes back **once**, as `data.secret` of the create or
rotate response, so it can be copied to the receiver. The panel's **Generate** button makes one in the form instead and
shows it once; a panel form left empty gets a generated secret that the panel does not show (rotate it through the API
to get one you can read). The list says only `signed` or `unsigned`. A viewer sees a webhook's address cut down to its origin (`https://host/`, `urlRedacted: true`):
a path often carries a token.

`job.progress` fires on every progress update. Subscribe to it only on a queue where updates are rare.

## What a delivery looks like

```http
POST /hook HTTP/1.1
Host: receiver.example
Content-Type: application/json
User-Agent: qelay-cloud-webhooks/1
X-Webhook-Id: 1842
X-Webhook-Event: job.failed
X-Webhook-Timestamp: 1789468800123
X-Webhook-Attempt: 1
X-Webhook-Signature: v1=5c1d...e0

{"id":"1842","event":"job.failed","timestamp":1789468799950,"queue":"emails","jobId":"01J...","state":"failed","error":"smtp 550"}
```

| Header | Meaning |
| --- | --- |
| `X-Webhook-Id` | The delivery's id. **The same on every attempt**: deduplicate on it |
| `X-Webhook-Event` | The event name. `webhook.test` for "Send test event" |
| `X-Webhook-Timestamp` | When this attempt was made, epoch milliseconds. Part of the signed text |
| `X-Webhook-Attempt` | 1 for the first attempt, then 2, 3 and so on. Keeps rising across a manual retry |
| `X-Webhook-Signature` | `v1=<hex>`, only when the webhook has a secret |
| `X-Webhook-Schema` | `1`, on a delivery with the default body described below. Absent when the webhook has a `shape`: the body is then the webhook's own and has no schema to number |

The body is JSON: `id`, `event`, `timestamp` (when the event happened), `queue`, `jobId`, and, when the journal still has
them, `state`, `error` (the failure text) and `progress`. **It carries no job data and no return value**: a receiver
that needs them asks the Control API with the job id.

A webhook with a `shape` gets the body its template makes instead (next section).

A test event (`POST /webhooks/{id}/test`, answered 202) is a delivery like any other, with the event `webhook.test` and
`queue` and `jobId` both `webhook-test`. It goes to that webhook whatever events it listens for, and it follows the
same retry schedule.

## Filters and shapes

A webhook can send **fewer events** (a `filter`) and **a body of its own** (a `shape`). Both are plain JSON data that the
service evaluates itself: no code runs, no address is fetched, and **neither can read a job's `data` or result**, which
the event journal does not carry. A field a filter or shape names is one of the event's seven:
`event`, `queue`, `jobId`, `state`, `error`, `progress`, `occurredAt`.

**They need the delivery writer.** By default a trigger in the job's transaction makes the deliveries and cannot apply
either. Switch the namespace to the writer, which makes them from the event journal a moment after the commit:

```bash
qcloud-tick webhook-writer on      # from the journal's end now; events before it are not delivered
qcloud-tick webhook-writer status  # {"mode":"writer"|"trigger"|"stopping","commitSeq":...,"eventId":...}
qcloud-tick webhook-writer off     # back to the trigger; refused while a webhook has a filter, shape, delay or dedupe
```

All three are safe to repeat and **lose no event in either direction**: on, the trigger stops for that namespace and the
writer starts at the journal's end (an overlap is deduplicated by the delivery's unique key); off, the trigger resumes
first, the writer catches up, and the last step waits for every job transaction that skipped its deliveries to commit
before it removes the writer's cursor. The tick's sender step and `qcloud-tick send` both do the writing (one pass per beat; a second writer finds
the cursor taken and does nothing), so with `QCLOUD_WEBHOOK_BATCH=0` and no `send` process nothing is written. Creating or changing a webhook to have a filter, shape, delay or de-duplication while the writer is off is refused: `400 unsupported_option` for
`writer`.

What the writer changes for a receiver: deliveries are made **a few seconds after** the job's commit, not in it; a job
and its deliveries are no longer atomic. The writer keeps its cursor in the same transaction as the rows it makes, so a
crash repeats a pass and duplicates nothing.

### Filter

An object whose terms must **all** hold:

```json
{ "queue": { "$startsWith": "billing" }, "error": { "$exist": true }, "progress": { "$gte": 50 } }
```

| Term | Meaning |
| --- | --- |
| `"<field>": "x"` or `5` | equals (same as `$eq`) |
| `"<field>": { ... }` | operators: `$eq`, `$in` (a list), `$exist` (true or false), `$startsWith` (text fields), `$gt`, `$gte`, `$lt`, `$lte` (numbers: `progress`, `occurredAt`) |
| `$and`, `$or` | a list of filters |
| `$not` | one filter |

A field the event has no value for (an `error` on a pushed event) matches only `$exist: false`. At most 50 terms, 4
levels deep, 20 values per list, 256 characters per text. A filter is a refinement of `events` and `queue`, never a
widening of them.

### Shape

An object that becomes the body. `{ "$": "<field>" }` is replaced by the event's field, with `"default": <value>` for
when it has none (without one the key is dropped, and an array entry becomes `null`); everything else is copied:

```json
{ "text": "Job failed", "job": { "queue": { "$": "queue" }, "id": { "$": "jobId" } }, "why": { "$": "error", "default": "unknown" } }
```

- Keys that start with `$` are reserved. At most 100 values, 6 levels deep, 8 KiB for the template.
- A text taken from the event is cut to 512 characters.
- **Keys come out shortest first, then alphabetically**, whatever order the template had them in (the order Postgres
  `jsonb` keeps). Receivers should not depend on key order.
- The body is **made once, when the delivery is written, and stored**: every attempt sends and signs the same bytes. A
  body past 64 KiB is not sent: the delivery is recorded as `failed` with `shaped body is larger than 65536 bytes`, so it
  shows in the history, and a retry of it is refused again.
- The delivery's id is not a field (the row does not exist yet): it is in the `X-Webhook-Id` header, as always.

### Delay and de-duplication

Two more rules of the writer, with the same needs and the same limits as a filter and a shape. An event meets a webhook's
rules in this order: **filter, de-duplication, shape, delay**, then the sender's rate limit and retries.

- **`delayMs`** makes each delivery as usual, but not due until `delayMs` after the event (1 second to 1 hour). A delayed
  delivery is waiting like any other: it expires after 24 hours of being due and is not sent while the webhook is off.
- **`dedupe`** is `{ windowMs, fields }`. `windowMs` is 1 second to 24 hours; `fields` is at least one of `event`, `queue`,
  `jobId`, `state` and `error`. Of the events the webhook accepts, the **first** with a given value of those fields is
  sent, and later ones with the same values inside the window are **dropped, not recorded** (there is no delivery row to
  retry). The window starts at the first event and a repeat does not extend it. The writer keeps a hash of the values
  (never the values) in `qcloud_webhook_dedupe`, in its own transaction, and the tick prunes it once a window has ended.
  This does not make a receiver idempotent: a retry of one delivery is still the same delivery, and a receiver dedupes on
  `X-Webhook-Id` as before.

### Changing one

`PATCH /webhooks/{id}` (operator) changes the `name`, `description`, `events`, `filter`, `shape`, `delayMs` and `dedupe`.
A key that is absent is left alone and `null` clears a name, description, filter, shape, delay or de-duplication; `events`
cannot be empty, and an empty body is `400`. The same checks as at creation apply (a rule needs the writer on:
`400 unsupported_option`). A change applies to events **from then on**: deliveries already made keep the body they were made
with. The source queue, the address and the secret are not editable here: add a new webhook and delete the old one, edit
the saved destination it came from, or [rotate the secret](#rotating-the-secret). The audit row holds the webhook's id and
no value. The panel's Settings tab is this call.

### Trying one before saving it

`POST /webhooks/preview` (operator) takes `{ filter?, shape?, event: { event, queue, jobId, occurredAt?, state?, error?,
progress? } }` and answers `{ matches, body, error }`: whether the filter lets that event through, and the bytes the
shape would send. Nothing is saved or sent. A filter or shape outside the grammar is `400 unsupported_option` naming
which, and the first fault.

### What a filter and shape do not do

- **A gap loses events.** If the journal's retention (see [limits.md](limits.md)) removes events before the writer reads
  them, those events make no deliveries; the writer reports it as the gauge `webhooks.writer_gaps` (1). Run a sender
  process so the writer is never hours behind.
- **A webhook sees only events after it was enabled.** Enabling a webhook that was disabled does not replay what happened
  while it was off; a webhook that was **paused** (held) does send what it collected ([below](#pausing-a-webhook-hold-or-ignore)).
- **Job data is not available** to a filter or shape, today.

## Verifying a signature

The signature is `HMAC-SHA256(secret, "<X-Webhook-Timestamp>.<raw body>")`, written as `v1=` and lower-case hex. The
timestamp is in the signed text, so a captured request cannot be replayed with a newer timestamp. The receiver:

1. Reads the **raw** body (not a re-serialised one).
2. Rejects a timestamp more than **300 seconds** from its own clock, in either direction.
3. Computes the HMAC and compares it in constant time.
4. Deduplicates on `X-Webhook-Id`.

```ts
async function verify(secret: string, headers: Headers, body: string, now = Date.now()): Promise<boolean> {
  const timestamp = headers.get('x-webhook-timestamp') ?? '';
  const signature = headers.get('x-webhook-signature') ?? '';
  if (!/^\d{1,16}$/.test(timestamp) || Math.abs(now - Number(timestamp)) > 300_000) return false;
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
  );
  const hex = signature.replace(/^v1=/, '');
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length % 2 !== 0) return false;
  const mac = Uint8Array.from(hex.match(/../g)!, (pair) => Number.parseInt(pair, 16));
  return crypto.subtle.verify('HMAC', key, mac, new TextEncoder().encode(`${timestamp}.${body}`));
}
```

While a secret is being rotated the header holds **two** signatures, comma-separated (`v1=<new>,v1=<old>`): accept the
request if any of them verifies (`verifyWebhookSignature` does; the example above checks only the first, so split on
`,` and try each).

`@qelay-cloud/core` exports the same check as `verifyWebhookSignature` (and `signWebhook`), and it is the code the tests
use. `packages/core/src/webhookCrypto.test.ts` pins a known vector, so a receiver written in another language can check
itself against it.

## Delivery, retries and what counts as success

- **2xx is success.** Anything else is a failed attempt: a 3xx (a redirect is **never followed**: change the webhook's
  URL instead), a 4xx or 5xx, a timeout (10 s for the whole exchange, name lookup to the status line), a refused or
  reset connection, a certificate that does not verify, a non-HTTP answer.
- A success is answered at its **status line**: nothing else is read. For a failed answer (status 300 or more) the sender
  also reads the **first 1 KB of its body** (`QCLOUD_WEBHOOK_RESPONSE_BYTES`, at most 4096, `0` turns it off), as text
  with control characters made spaces (an encoded body, such as gzip, is not kept), and keeps it as `response` on that
  attempt's history entry, cut to 1,024 characters. It is not read at all when the sender runs with private addresses
  allowed (`QCLOUD_WEBHOOK_DEV_MODE`), unless `QCLOUD_WEBHOOK_RESPONSE_BYTES` is set: an internal service's error page is not the
  operator's to read through the history. The rest of the body is never buffered. The request carries
  `User-Agent: qelay-cloud-webhooks/1` (`QCLOUD_WEBHOOK_USER_AGENT` sets another, printable ASCII, at most 100 characters).
- A failed attempt is retried after 30 s, 1 m, 2 m, 4 m, 8 m, 16 m and 32 m, up to **8 attempts** (63.5 minutes of
  waiting, plus the request times). Those are the schedule's centre: each wait is spread by plus or minus 20 %, so the
  deliveries a receiver refused during one outage do not all return in the same second (a wait at the longest-wait cap
  is only spread shorter). After the last, the delivery is `failed`.
- A delivery never sent in the 24 hours after it was due (a webhook that is switched off, or a backlog the sender could
  not work down) is failed with `expired: not delivered within 24 hours`.
- **Retry** on a failed delivery (panel or `POST /webhooks/{id}/deliveries/{deliveryId}/retry`) gives it a fresh budget
  of attempts. The attempt numbers go on rising, so the history stays one list. A delivery that is waiting, being sent
  or delivered is refused (`delivery_not_failed`, 409): retrying it would send it twice.
- Delivery states: `pending` (waiting for its time), `sending` (claimed by a sender), `delivered`, `failed`.
- The history keeps the **last 20 attempts** of a delivery: when it started, how long it took, the status the receiver
  answered, a short reason and, for a failure, the first bytes of the answer's body (above). **Never a resolved address.** Finished deliveries are kept
  **2 days** by default (`QCLOUD_WEBHOOK_KEEP_MS`): deliveries live in a table partitioned by day, and the tick drops a
  day whole once its end is that old, so a drop leaves nothing for vacuum. A day that still holds a delivery waiting to be
  sent or retried is not dropped. Rows that did not land in a day partition (written before the tick made it) are deleted
  one by one after the same time.

The retry is at-least-once. A delivery can reach a receiver more than once:

- the receiver answered 2xx after the sender gave up on it (a slow receiver at the timeout);
- a sender died after the request and before it recorded the answer; the lease (30 s) lapses and the next tick sends
  again, and an answer that arrives after the lapse is dropped;
- a manual retry of something the receiver had in fact processed.

Deduplicate on `X-Webhook-Id`. It is the same for every attempt of one delivery, and different for every event.

## When a receiver keeps failing

A webhook counts its **failed deliveries in a row**: a delivery that used every attempt without success adds one, a
delivered one resets the count to 0 (attempts that will be retried do not count). Its `alertLevel` follows the count:
1 at 50 %, 2 at 70 %, 3 at 90 % and 4 at 100 % of `QCLOUD_WEBHOOK_DISABLE_AFTER` (default **20**; `0` turns the pause
off, and with it the levels). At level 4 the webhook is **paused**: `enabled` becomes `false`, `disabledReason` says
`20 failed deliveries in a row`, `disabledAt` when, and the sender stops claiming it.

- A paused webhook **still collects deliveries**, so what the receiver missed is not lost at once: they wait, and expire
  after 24 hours like any unsent delivery (`expired: not delivered within 24 hours`).
- **Enabling it again** (`PUT /webhooks/{id}/enabled`, or the panel) clears the pause and the count, and sends what was
  held. Fix the receiver first: nothing is replayed beyond those 24 hours, and a failed delivery that exhausted before the
  pause stays `failed` until you retry it.
- Disabling a webhook by hand (mode `ignore`) sets no reason and is never a pause; late results from deliveries already out
  do not pause it.
- Pausing is decided where results are recorded, so a webhook with several deliveries in flight can pass the threshold by a few.

## Pausing a webhook: hold or ignore

`PUT /webhooks/{id}/enabled` takes `{ "enabled": false, "mode": "hold" | "ignore" }`; `mode` defaults to `ignore`, which is
what the call did before it existed, and is moot when turning a webhook on. Turning one off stops the sender at once, retries
included. There are **three** off states, and `pausedBy` on a read says which:

| State | How it happens | New events | `pausedBy` | Enabling |
| --- | --- | --- | --- | --- |
| Disabled (**ignore**) | `mode: ignore`, the panel's **Disable** | Not collected | `null` | Sends nothing from the time it was off |
| Paused by an operator (**hold**) | `mode: hold`, the panel's **Pause**; `disabledReason` is `paused by an operator` | Collected, and wait | `operator` | Sends what was held |
| Paused for failing | [Auto-pause](#when-a-receiver-keeps-failing); `disabledReason` is `20 failed deliveries in a row` | Collected, and wait | `failures` | Clears the count and sends what was held |

What waits expires after 24 hours like any unsent delivery, in both held states. Deliveries already waiting when a webhook is
disabled stay and go out when it is enabled, unless they have expired. Turning a held or failing webhook off with `ignore`
ends the hold. `hold` on a webhook paused for failing keeps its reason and its failure streak.

## Rotating the secret

`POST /webhooks/{id}/rotate-secret` with `{"secret": "..."}` or no body (one is generated and returned once). The old
secret keeps signing **beside** the new one for **24 hours** (`previousSecretUntil` says when it stops), so the receiver
can be changed without a failed delivery; rotating again within the day drops the older secret. A store without
`QCLOUD_WEBHOOK_KEY` refuses (`webhook_key_missing`). Webhooks made before always-sign stay unsigned until rotated.

## What is not promised

- **No ordering.** Events are delivered in the order they became due, best effort. Two events of one job can arrive
  swapped (the first was retried), and attempts of different webhooks are interleaved. The body's `timestamp` says when
  each happened; `state` is the job's state after that event, not now.
- **No delivery for a webhook that did not exist yet.** A webhook sees events committed after it was registered.
- **No job data**, as above.
- **A late outcome after a lease lapse is dropped**, so a delivery can be sent twice (above) but is never recorded as
  both delivered and failed.
- **Failures are not paged.** A webhook whose receiver is down accrues failed deliveries and, after 20 in a row, is paused
  (below). Nothing is sent to you: the webhook's `alertLevel` and `disabledReason`, the `webhook_failing` and
  `webhook_paused` warnings on `GET /deployment` and the `webhooks.paused` gauge are where to look, and the panel shows
  the failure count and, in the delivery history, the last error and the first bytes of the receiver's answer.

## Where a webhook may point

The service sends requests from inside the operator's network, so the destination is the attack surface. A webhook
cannot be made a way to reach what that network trusts (cloud metadata, a database, an admin port).

- **`https:` only**, and no `user:password@` in the URL. `http:` is for development (below).
- The host must not be a name with no dot, a cloud metadata name (`metadata.goog`) or a private suffix (`localhost`,
  `local`, `internal`, `localdomain`, `home.arpa`, `lan`, `corp`, `intranet`) and, whether given as a name or
  as an address in any notation (decimal, hex, octal, short, mixed IPv6), must not be in a range that is not global
  unicast: loopback, private, link-local (the metadata address), shared address space, documentation, multicast and the
  rest of the registry's non-global blocks; for IPv6 only `2000::/3` minus the documentation and protocol blocks.
  Addresses that embed an IPv4 address (mapped, NAT64, 6to4) are judged by it.
- The check is made **at registration and again at every send**. Registration validates the URL string; it **does not
  resolve the name** (a name can point anywhere a second later), so a webhook to a name that resolves to a private
  address is accepted and then every attempt fails with `destination not allowed`.
- At send time the host is resolved **once**, **every** answer must be public (a name with one public and one private
  record is refused), and the request goes to **the address that was checked**, never to the name again: that closes
  DNS rebinding. TLS is verified against the name the operator wrote.
- **A redirect is a failed attempt**, so a public receiver cannot bounce the sender to an internal address.
- The answer is never stored, so a webhook pointed at something internal could not be used to read it back through the
  delivery history. The error of an attempt is one of a fixed set of sentences.
- Per webhook, at most **60 attempts a minute** (fixed window); the rest wait their turn.

An independent review of this section is owed in task 72. The checks have tests for each class above, including a
redirect and a rebinding resolver (`packages/maintenance/test/webhook.*.test.ts`, `packages/core/src/webhookUrl.test.ts`).

### Development mode

`QCLOUD_WEBHOOK_DEV_MODE=true` allows `http:` and loopback or private destinations, so a webhook can deliver to a receiver
on `localhost`. **Development only.** It removes the checks above for every webhook; a production deployment must not
set it. It must be set on the Control API and on the tick: each applies the policy it is given.

## Configuration

Read from the environment by the Control API and by the tick (`qcloud-tick run | serve`) and by the sender process (`qcloud-tick send`); a wrong value throws naming the
variable and never repeating its value.

| Variable | Meaning | Default |
| --- | --- | --- |
| `QCLOUD_WEBHOOK_KEY` | The key secrets are sealed with: 32 bytes as 64 hex digits or base64. **Without it a webhook cannot be given a secret** (`webhook_key_missing`, 409). The Control API and the tick need the same key. Keep it in the secret manager, **not in the database**: the database holds only sealed secrets (AES-256-GCM, authenticated with the row's identity so a sealed secret copied to another row does not open). A lost key means every secret is gone: re-enter them | unset |
| `QCLOUD_WEBHOOK_DEV_MODE` | `true` or `false`, see above | `false` |
| `QCLOUD_WEBHOOK_BATCH` | Deliveries one pass sends at most. **0 turns sending off** (deliveries wait, pending) | 50 |
| `QCLOUD_WEBHOOK_CONCURRENCY` | Requests in flight at once | 8 |
| `QCLOUD_WEBHOOK_BUDGET_MS` | No new chunk of requests starts after this much of a pass. A pass can overrun by one request timeout | 5,000 |
| `QCLOUD_WEBHOOK_TIMEOUT_MS` | The bound on one attempt | 10,000 |
| `QCLOUD_WEBHOOK_LEASE_MS` | How long a claimed delivery is its sender's. At least the timeout plus 5,000 | 30,000 |
| `QCLOUD_WEBHOOK_RATE_PER_MINUTE` | Attempts one webhook gets in a minute | 60 |
| `QCLOUD_WEBHOOK_KEEP_MS` | How long a finished delivery stays readable. The tick uses it; with several ticks on one database the **shortest** value decides, because each drops by its own | 172,800,000 |
| `QCLOUD_WEBHOOK_MAX_ATTEMPTS`, `_BASE_DELAY_MS`, `_MAX_DELAY_MS` | The retry policy (attempts, first wait, longest wait) | 8, 30,000, 3,600,000 |
| `QCLOUD_WEBHOOK_DISABLE_AFTER` | Failed deliveries in a row after which a webhook is paused. 0: never | 20 |
| `QCLOUD_WEBHOOK_KEEPALIVE_MS` | `send` only. How long a connection to a receiver is kept for the next delivery. 0: one connection per delivery | 15,000 |
| `QCLOUD_WEBHOOK_DNS_TTL_MS` | `send` only. How long a name's addresses are kept. 0: a lookup per delivery. Every address is checked on every use, cached or not | 30,000 |
| `QCLOUD_WEBHOOK_PER_DESTINATION` | `send` only. Requests in flight to one host and port, whatever webhooks point at it | 4 |
| `QCLOUD_WEBHOOK_BREAKER_FAILURES` | `send` only. Failed attempts in a row (no connection, timeout, 5xx, 429) after which a destination is paused. 0: never | 5 |
| `QCLOUD_WEBHOOK_BREAKER_COOLDOWN_MS` | `send` only. How long a paused destination is not connected to, before one attempt is let through to see if it is back | 30,000 |
| `QCLOUD_WEBHOOK_IDLE_MS` | `send` only. How long the sender waits before asking the store again when nothing is due | 500 |

## Where the work happens

- **The database.** A trigger on the job-event journal inserts one delivery row per enabled webhook that matches the
  event, **in the same transaction** as the job's own change, so a job and its deliveries are committed together or not
  at all (unless the namespace has the [delivery writer](#filters-and-shapes) on, which makes the rows from the journal a
  moment later instead). A webhook that did not exist yet gets nothing. The trigger costs the job path about **1.1x** on claim and
  complete and **1.6x** on enqueue with nine delivery rows per job, 8 claimers and 2,000 jobs
  (`packages/store-postgres/test/webhook.cost.test.ts`, PostgreSQL 18.6, one machine). A queue no webhook watches pays
  for the trigger's lookup only and inserts nothing.
- **The tick.** After the store's own work and ringing, the tick runs a **sender step**: it claims due deliveries
  (`FOR NO KEY UPDATE SKIP LOCKED` on the webhook rows, so any number of ticks can run at once and **never send the same
  attempt twice**), sends them, and records each outcome. The claim is round-robin across webhooks, so a webhook with a
  backlog does not take every slot from one with a single delivery, and a per-webhook rate limit applies.
- **The sender process.** `qcloud-tick send` runs only the sender, as a long-running process (no schedule, until
  `SIGTERM`), next to the tick or instead of the tick's sender step; both claim the same way and never send the same
  attempt twice. It keeps up to `QCLOUD_WEBHOOK_CONCURRENCY` requests in flight and refills a slot as soon as it frees,
  so a slow receiver holds up one slot, not a chunk. Against the tick step it adds three things, all per process and in
  memory:
  - **Connections are kept** (`QCLOUD_WEBHOOK_KEEPALIVE_MS`). A connection is kept only after a clean answer whose end
    is known (`HTTP/1.1`, a `Content-Length` of at most 64 KiB or a 204 or 304, no `Connection: close`, nothing after
    it). It is keyed by address, port, TLS name and CA, so one verified for a name is never used for another. A kept
    connection the receiver closed meanwhile is replaced once, on a new connection, without counting as a failure.
  - **Names are kept** (`QCLOUD_WEBHOOK_DNS_TTL_MS`), and a burst to one name does one lookup. The address check is not
    cached: every address is checked each time, so a name that turns private is refused after its entry expires.
  - **A failing receiver is paused** (`QCLOUD_WEBHOOK_BREAKER_*`). After the set number of failed attempts in a row to a
    host and port, attempts to it are refused without a connection until the cooldown ends, then one goes through. A
    refused attempt is **recorded as a failed attempt**, so it uses one of the delivery's attempts as the send it replaced
    would have; the store cannot hand a claim back, and holding it would dodge the 24-hour expiry. With the default
    retry schedule a delivery to a receiver that stays down still fails after its 8 attempts.
- **The receiver being down is not the tick being down.** A failing receiver is a failed delivery, and the tick's
  health is unaffected. A store error in the sender fails the tick, as any store error does.

## Volume

The sender is a tick step sized for **operator-scale** volume: tens of events a minute across a handful of webhooks. On
a scheduler-only deployment the tick runs once a minute, so a delivery is sent up to a minute late (see
[limits.md](limits.md) section 1); an always-on worker with the in-process tick sends within its interval.

- A sustained event rate above what the sender sends (50 a pass by default, 60 a minute per webhook) grows the backlog
  until the 24-hour expiry fails it. Raise `QCLOUD_WEBHOOK_BATCH` and `_RATE_PER_MINUTE`, or narrow the subscription.
- **`qcloud-tick send` raises the ceiling, not the per-webhook rate.** Deliveries are no longer sent in chunks inside a
  pass, so with `QCLOUD_WEBHOOK_CONCURRENCY` raised and `_RATE_PER_MINUTE` raised to match, thousands a minute across many
  webhooks is the design point. The rate limit is still per webhook (60 a minute by default): one webhook with a deep
  backlog is slow on purpose. Run more than one sender for availability, not for the rate. These are design figures; no
  receiver at that rate has been measured.
- **Fan-out or volume belongs in a delivery queue of your own**: a worker that consumes a job's completion and calls the
  receiver, on the SDK, with its own retry, concurrency and scaling. A webhook is the right tool for "tell the chat
  channel a job failed", not for "notify ten thousand customers".
