# Webhooks

Whatever is posted to an [inbound source](event-gateway.md#sources) is stored, and each route of the source can send it on to
a URL, **at least once**. Post `{ "id": 500, "name": "chris" }` and, with no rules on the route, the receiver gets
`{ "id": 500, "name": "chris" }` with the content type it was posted with. Written for two readers: the operator who sets
routes up, and the engineer who writes the receiver.

A webhook is the `http` destination of an [event gateway](event-gateway.md) route. This page is the reference for that
destination: the request, the signature, retries and where a URL may point. A route can instead add a job to a queue
(`destination: "queue"`), which has no URL, no secret and none of the checks below.

What a webhook is not: an ordered stream (see [What is not promised](#what-is-not-promised)) or a fan-out service (see
[Volume](#volume)).

## Registering one

Panel: **Event gateway**, Connections (operators only). Control API: `POST /webhooks`, with the `operator` role; every call that changes a
webhook leaves one audit row naming `webhook=<id>` and nothing else (no URL, no secret).

| Field | Meaning |
| --- | --- |
| `source` | The id of the [inbound source](event-gateway.md#sources) whose requests the route sends. Required: a route with no source cannot be turned on |
| `url` | `https:` only (see [Where a webhook may point](#where-a-webhook-may-point)), at most 2,048 characters, no credentials in it |
| `secret` | Optional, 16 to 256 characters. **Every delivery is signed** when the deployment has `QCLOUD_WEBHOOK_KEY`: with no `secret`, the service generates one (see [Rotating the secret](#rotating-the-secret)). Without the key a webhook has no secret and is sent unsigned (`signed: false`) |
| `filter` | Optional. Only requests it lets through are sent (see [Filters and shapes](#filters-and-shapes)) |
| `shape` | Optional. A template for the body. Without one the request body goes through unchanged |
| `delayMs` | Optional, 1,000 to 3,600,000 (1 second to 1 hour). Each delivery is due this long after its request (see [Delay and de-duplication](#delay-and-de-duplication)) |
| `dedupe` | Optional. `{ windowMs, fields }`: drop repeats of a request inside a window |
| `name`, `description` | Optional, at most 80 and 500 characters. What the operator calls the webhook; they change nothing about delivery |
| `destinationId` | Optional. Takes the address from a [saved destination](event-gateway.md#saved-destinations) instead of `url`; it cannot be combined with `url` |

At most **100** webhooks per namespace. The Control API never returns a secret you gave, and no read returns any secret:
the one exception is a secret the service generated, which comes back **once**, as `data.secret` of the create or
rotate response, so it can be copied to the receiver. The panel's **Generate** button makes one in the form instead and
shows it once; a panel form left empty gets a generated secret that the panel does not show (rotate it through the API
to get one you can read). The list says only `signed` or `unsigned`. A viewer sees a webhook's address cut down to its origin (`https://host/`, `urlRedacted: true`):
a path often carries a token.

## What a delivery looks like

```http
POST /hook HTTP/1.1
Host: receiver.example
Content-Type: application/json
User-Agent: qelay-cloud-webhooks/1
X-Webhook-Id: 1842
X-Webhook-Event: request.received
X-Webhook-Timestamp: 1789468800123
X-Webhook-Attempt: 1
X-Webhook-Signature: v1=5c1d...e0

{"id":500,"name":"chris"}
```

| Header | Meaning |
| --- | --- |
| `X-Webhook-Id` | The delivery's id. **The same on every attempt**: deduplicate on it |
| `X-Webhook-Event` | `request.received` for a request. `webhook.test` for "Send test event". `webhook.batch` for a [batch](#schedule-and-batch), whose `X-Webhook-Id` is the batch's id |
| `X-Webhook-Timestamp` | When this attempt was made, epoch milliseconds. Part of the signed text |
| `X-Webhook-Attempt` | 1 for the first attempt, then 2, 3 and so on. Keeps rising across a manual retry |
| `X-Webhook-Signature` | `v1=<hex>`, only when the webhook has a secret |
| `X-Webhook-Schema` | `1`, on a test event only (Qelay's own small document). A request's body is the sender's own or the route's `shape`, and has no schema to number |

**The body is what was posted**, byte for byte, with the request's `Content-Type` (`application/octet-stream` when it had none
or one that is not printable ASCII). Nothing is added and nothing is removed, and the signature covers exactly those bytes.
A route with a `shape` sends the JSON its template makes instead (next section). The headers and query string of the
request are not forwarded; a `shape` can copy the ones a receiver needs.

A test event (`POST /webhooks/{id}/test`, answered 202) is a delivery like any other, with the event `webhook.test` and
the body `{"id":"...","event":"webhook.test","timestamp":...}`. It goes to that route whatever its source holds, and it
follows the same retry schedule.

## Filters and shapes

A webhook can send **fewer requests** (a `filter`) and **a body of its own** (a `shape`). Both are plain JSON data that the
service evaluates itself: no code runs and no address is fetched. They see the request as a **document**,
`{ method, headers, query, body }`, and name a value by a dotted **path**:

| Path | Holds |
| --- | --- |
| `method` | `POST`, `PUT`, `PATCH` or `DELETE` |
| `headers.<name>` | A request header, its name in lower case (`headers.x-github-event`). The credential headers (`authorization`, `cookie`, `proxy-authorization`, `set-cookie` and the source's own verification header) read `[redacted]` |
| `query.<name>` | A query-string parameter |
| `body.<path>` | A field of the JSON body (`body.customer.id`, and `body.items.0.sku` for an array). `body` exists only when the request was JSON: any other body is not addressable and passes through whole |

A path has at most 8 segments of letters, digits, `-` and `_`, up to 64 characters each. A key with a dot or a space
cannot be named.

Every request meets a route's rules at the moment it is stored, in this order: **pause mode, filter, de-duplication,
shape, delay**, then the sender's rate limit and retries. A request a rule drops makes no delivery for that route.

### Filter

An object whose terms must **all** hold:

```json
{ "headers.x-event": { "$startsWith": "invoice" }, "body.email": { "$exist": true }, "body.amount": { "$gte": 50 } }
```

| Term | Meaning |
| --- | --- |
| `"<path>": "x"` or `5` | equals (same as `$eq`) |
| `"<path>": { ... }` | operators: `$eq`, `$in` (a list), `$exist` (true or false), `$startsWith` (text), `$gt`, `$gte`, `$lt`, `$lte` (numbers) |
| `$and`, `$or` | a list of filters |
| `$not` | one filter |

A path the request has no value for matches only `$exist: false`, and a value of another type than the term's does not
match. At most 50 terms, 4 levels deep, 20 values per list, 256 characters per text.

### Shape

An object that becomes the body. `{ "$": "<path>" }` is replaced by the request's value at that path, with
`"default": <value>` for when it has none (without one the key is dropped, and an array entry becomes `null`);
everything else is copied:

```json
{ "text": "New order", "order": { "id": { "$": "body.id" }, "kind": { "$": "headers.x-event" } }, "who": { "$": "body.name", "default": "unknown" } }
```

- Keys that start with `$` are reserved. At most 100 values, 6 levels deep, 8 KiB for the template.
- **A shape means JSON.** The body it makes is JSON, sent as `application/json`, whatever the request was.
- **Keys come out shortest first, then alphabetically**, whatever order the template had them in (the order Postgres
  `jsonb` keeps). Receivers should not depend on key order.
- The body is **made once, when the request is stored, and kept**: every attempt sends and signs the same bytes. A
  body past 64 KiB is not sent: the delivery is recorded as `failed` with `shaped body is larger than 65536 bytes`, so it
  shows in the history, and a retry of it is refused again.
- The delivery's id is not a field (the row does not exist yet): it is in the `X-Webhook-Id` header, as always.

### Delay and de-duplication

- **`delayMs`** makes each delivery as usual, but not due until `delayMs` after the request (1 second to 1 hour). A delayed
  delivery is waiting like any other: it expires after 24 hours of being due and is not sent while the webhook is off.
- **`dedupe`** is `{ windowMs, fields }`. `windowMs` is 1 second to 24 hours; `fields` is one to five paths of the
  document (`body.id`). Of the requests the route accepts, the **first** with a given value of those paths is sent, and
  later ones with the same values inside the window are **dropped, not recorded** (there is no delivery row to retry).
  The window starts at the first request and a repeat does not extend it. The store keeps a hash of the values (never
  the values) in `qcloud_webhook_dedupe`, and the tick prunes it once a window has ended. The window is opened by one
  atomic upsert, so requests that arrive together on several ingest processes still send once. This does not make a
  receiver idempotent: a retry of one delivery is still the same delivery, and a receiver dedupes on `X-Webhook-Id` as
  before.

### Schedule and batch

Two settings on a route (`POST /webhooks`, `PATCH /webhooks/{id}`), both off by default and both checked when the route is saved.

- **`schedule`** is `{ cron, timezone }`: a cron expression of five or six fields (or a shortcut such as `@daily`) and an IANA
  zone (`UTC` when left out). Events are **held until the next fire**, then sent. A delivery's due time is the first fire at or
  after the request plus the route's `delayMs`, so a night's events wait for midnight and go together. A schedule that does not
  parse, never fires, or fires less often than every 31 days is refused (`400 unsupported_option` naming `schedule`). A read of
  the route returns `nextSendAt`, the next fire in epoch milliseconds. Held events are stored like any other delivery, so a
  route that holds a day's worth holds a day's worth of rows; they count against [retention](#configuration) and against the
  24-hour expiry below.
- **`batch`** is `{ maxEvents, maxBytes }` (1 to 500 events, 1,024 to 1,048,576 bytes; 100 and 262,144 when you leave them out):
  the due events of the route go out as **one signed request**. It is for `http` routes only. Without `batch` every event is its
  own request, as before.

A batch is a JSON envelope. The events keep the order they were taken in; a JSON body is nested as JSON, other text as a string,
bytes that are not UTF-8 as `{ "base64": "..." }`, and a request with no body as `null`.

```json
{
  "batchId": "9f2c...e1",
  "count": 2,
  "events": [
    { "id": "1842", "receivedAt": 1789468800123, "body": { "id": 500, "name": "chris" } },
    { "id": "1843", "receivedAt": 1789468800456, "body": "plain text" }
  ]
}
```

The request is signed like any other, over the envelope, with `X-Webhook-Event: webhook.batch`. `X-Webhook-Id` is the
**`batchId`**, a hash of the members' ids, so the same members give the same id on a retry and a receiver can drop a repeat;
`X-Webhook-Attempt` is the highest attempt any member has used. Each `id` in `events` is that event's own delivery id.

- **All or nothing.** A `2xx` marks every event of the batch delivered; anything else fails them all, and they retry **together**
  at one time on the route's normal schedule. A receiver that wants to accept some must still answer `2xx` and keep the rest.
- **The limit is per request, not per event.** A batch stops at `maxEvents` or at `maxBytes`, whichever comes first, and the
  first event always goes, so an event larger than `maxBytes` is sent alone. Events past the limit stay due and go in the next
  batch.
- **One batch per route per pass.** The sender claims one batch for each batch route in a pass, and counts it as **one**
  attempt toward the pass limit and the route's 60 a minute. A backlog of 250 events at `maxEvents` 100 therefore takes three
  passes. On a scheduler-only deployment that is three minutes; `qcloud-tick send` as its own process drains it in seconds
  ([where the work happens](#where-the-work-happens), [production settings](production.md#scheduled-and-batched-sends)).
- **A shaped body that cannot be made fails alone** and is left out of the envelope; the others go.
- The history of each event names its `batchId`, and a delivery sent alone has none. Streak counting and auto-pause still count
  each event, so a receiver that refuses a batch of 100 adds 100 to the failure streak.

### Changing one

`PATCH /webhooks/{id}` (operator) changes the `name`, `description`, `source`, `filter`, `shape`, `delayMs`, `dedupe`, `schedule` and `batch`.
A key that is absent is left alone and `null` clears a name, description, filter, shape, delay, de-duplication, schedule or batch; `source`
cannot be cleared, and an empty body is `400`. The same checks as at creation apply. A change applies to requests **from
then on**: deliveries already made keep the body they were made with. The address and the secret are not editable here:
add a new webhook and delete the old one, edit the saved destination it came from, or [rotate the
secret](#rotating-the-secret). The audit row holds the webhook's id and no value. The panel's Settings tab is this call.

### Trying one before saving it

`POST /webhooks/preview` (operator) takes `{ filter?, shape?, request: { method?, headers?, query?, body? } }` and answers
`{ preview: { matches, body, error } }`: whether the filter lets that request through, and the bytes the shape would send.
Nothing is saved or sent. A filter or shape outside the grammar is `400 unsupported_option` naming which, and the first
fault.

### What a filter and shape do not do

- **They cannot read a form body.** A request that is not JSON is stored whole and sent whole when the route has no shape;
  there is no `body.<path>` for it.
- **A route sees only requests that arrive while it is on.** Turning on a route that was disabled does not replay what was
  posted while it was off; a route that was **paused** (held) does send what it collected
  ([below](#pausing-a-webhook-hold-or-ignore)). A stored request can be replayed to its source's routes (`POST /requests/{id}/replay`).

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

- **No ordering.** Requests are delivered in the order they became due, best effort. Two requests can arrive swapped (the
  first was retried), and attempts of different webhooks are interleaved.
- **No delivery for a route that did not exist yet.** A route sees requests stored after it was registered.
- **A late outcome after a lease lapse is dropped**, so a delivery can be sent twice (above) but is never recorded as
  both delivered and failed.
- **Failures are not paged.** A webhook whose receiver is down accrues failed deliveries and, after 20 in a row, is paused
  ([above](#when-a-receiver-keeps-failing)). Nothing is sent to you: the webhook's `alertLevel` and `disabledReason`, the `webhook_failing` and
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

- **The database.** The request is stored and **its deliveries are made in the same transaction**: one row per enabled
  route of the source that the filter, the de-duplication and the pause mode let through. A request that is stored has
  all its deliveries or none. A route that did not exist yet gets nothing, and the ingest never calls a receiver: the
  sender below does. There is no journal to read and no cursor to keep, so nothing falls behind.
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

The sender is a tick step sized for **operator-scale** volume: tens of requests a minute across a handful of webhooks. On
a scheduler-only deployment the tick runs once a minute, so a delivery is sent up to a minute late (see
[limits.md](limits.md) section 1); an always-on worker with the in-process tick sends within its interval.

- A sustained request rate above what the sender sends (50 a pass by default, 60 a minute per webhook) grows the backlog
  until the 24-hour expiry fails it. Raise `QCLOUD_WEBHOOK_BATCH` and `_RATE_PER_MINUTE`, or add a `filter` to the route.
- **`qcloud-tick send` raises the ceiling, not the per-webhook rate.** Deliveries are no longer sent in chunks inside a
  pass, so with `QCLOUD_WEBHOOK_CONCURRENCY` raised and `_RATE_PER_MINUTE` raised to match, thousands a minute across many
  webhooks is the design point. The rate limit is still per webhook (60 a minute by default): one webhook with a deep
  backlog is slow on purpose. Run more than one sender for availability, not for the rate. These are design figures; no
  receiver at that rate has been measured.
- **Fan-out or volume belongs in a delivery queue of your own**: a `queue` route that adds a job per request, and a worker
  that calls the receivers, on the SDK, with its own retry, concurrency and scaling. A webhook is the right tool for "tell
  the chat channel a payment arrived", not for "notify ten thousand customers".
