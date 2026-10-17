# Webhooks

An operator registers a URL and the job events it wants. Qelay-Cloud POSTs each matching event to it, **at least once**.
Written for two readers: the operator who sets webhooks up, and the engineer who writes the receiver.

What a webhook is not: a way to move job data (the body has none), an ordered stream (see
[What is not promised](#what-is-not-promised)) or a fan-out service (see [Volume](#volume)).

## Registering one

Panel: **Webhooks** (operators only). Control API: `POST /webhooks`, with the `operator` role; every call that changes a
webhook leaves one audit row naming `webhook=<id>` and nothing else (no URL, no secret).

| Field | Meaning |
| --- | --- |
| `url` | `https:` only (see [Where a webhook may point](#where-a-webhook-may-point)), at most 2,048 characters, no credentials in it |
| `events` | One or more of `job.pushed`, `job.started`, `job.completed`, `job.failed`, `job.progress` |
| `queue` | One queue name, or none for every queue. A list of queues is not offered: register one webhook per queue |
| `secret` | Optional, 16 to 256 characters. With one, every delivery is signed. Without, deliveries are sent unsigned and the webhook is listed as `signed: false` |

At most **100** webhooks per namespace. The Control API never returns a secret after the call that sets it: the panel's
**Generate** button shows the new one once, in the form, so it can be copied to the receiver, and the list says only
`signed` or `unsigned`. A viewer sees a webhook's address cut down to its origin (`https://host/`, `urlRedacted: true`):
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

The body is JSON: `id`, `event`, `timestamp` (when the event happened), `queue`, `jobId`, and, when the journal still has
them, `state`, `error` (the failure text) and `progress`. **It carries no job data and no return value**: a receiver
that needs them asks the Control API with the job id.

A test event (`POST /webhooks/{id}/test`, answered 202) is a delivery like any other, with the event `webhook.test` and
`queue` and `jobId` both `webhook-test`. It goes to that webhook whatever events it listens for, and it follows the
same retry schedule.

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

`@qelay-cloud/core` exports the same check as `verifyWebhookSignature` (and `signWebhook`), and it is the code the tests
use. `packages/core/src/webhookCrypto.test.ts` pins a known vector, so a receiver written in another language can check
itself against it.

## Delivery, retries and what counts as success

- **2xx is success.** Anything else is a failed attempt: a 3xx (a redirect is **never followed**: change the webhook's
  URL instead), a 4xx or 5xx, a timeout (10 s for the whole exchange, name lookup to the status line), a refused or
  reset connection, a certificate that does not verify, a non-HTTP answer.
- Only the **status line** of the answer is read. The rest is never buffered and never stored.
- A failed attempt is retried after 30 s, 1 m, 2 m, 4 m, 8 m, 16 m and 32 m, up to **8 attempts** (63.5 minutes of
  waiting, plus the request times). No jitter. After the last, the delivery is `failed`.
- A delivery never sent in the 24 hours after it was due (a webhook that is switched off, or a backlog the sender could
  not work down) is failed with `expired: not delivered within 24 hours`.
- **Retry** on a failed delivery (panel or `POST /webhooks/{id}/deliveries/{deliveryId}/retry`) gives it a fresh budget
  of attempts. The attempt numbers go on rising, so the history stays one list. A delivery that is waiting, being sent
  or delivered is refused (`delivery_not_failed`, 409): retrying it would send it twice.
- Delivery states: `pending` (waiting for its time), `sending` (claimed by a sender), `delivered`, `failed`.
- The history keeps the **last 20 attempts** of a delivery: when it started, how long it took, the status the receiver
  answered, and a short reason. **Never a response body and never a resolved address.** Finished deliveries are kept
  7 days.

The retry is at-least-once. A delivery can reach a receiver more than once:

- the receiver answered 2xx after the sender gave up on it (a slow receiver at the timeout);
- a sender died after the request and before it recorded the answer; the lease (30 s) lapses and the next tick sends
  again, and an answer that arrives after the lapse is dropped;
- a manual retry of something the receiver had in fact processed.

Deduplicate on `X-Webhook-Id`. It is the same for every attempt of one delivery, and different for every event.

## What is not promised

- **No ordering.** Events are delivered in the order they became due, best effort. Two events of one job can arrive
  swapped (the first was retried), and attempts of different webhooks are interleaved. The body's `timestamp` says when
  each happened; `state` is the job's state after that event, not now.
- **No delivery for a webhook that did not exist yet.** A webhook sees events committed after it was registered.
- **No job data**, as above.
- **A late outcome after a lease lapse is dropped**, so a delivery can be sent twice (above) but is never recorded as
  both delivered and failed.
- **Failures are not alerts.** A webhook whose receiver is down accrues failed deliveries; nothing is paged. The panel
  shows the failure count per webhook and, in its delivery history, the last error of each delivery.

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

Read from the environment by the Control API and by the tick (`qcloud-tick run | serve`); a wrong value throws naming the
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
| `QCLOUD_WEBHOOK_MAX_ATTEMPTS`, `_BASE_DELAY_MS`, `_MAX_DELAY_MS` | The retry policy (attempts, first wait, longest wait) | 8, 30,000, 3,600,000 |

## Where the work happens

- **The database.** A trigger on the job-event journal inserts one delivery row per enabled webhook that matches the
  event, **in the same transaction** as the job's own change. A job and its deliveries are committed together or not at
  all, and a webhook that did not exist yet gets nothing. The trigger costs the job path about **1.1x** on claim and
  complete and **1.6x** on enqueue with nine delivery rows per job, 8 claimers and 2,000 jobs
  (`packages/store-postgres/test/webhook.cost.test.ts`, PostgreSQL 18.6, one machine). A queue no webhook watches pays
  for the trigger's lookup only and inserts nothing.
- **The tick.** After the store's own work and ringing, the tick runs a **sender step**: it claims due deliveries
  (`FOR NO KEY UPDATE SKIP LOCKED` on the webhook rows, so any number of ticks can run at once and **never send the same
  attempt twice**), sends them, and records each outcome. The claim is round-robin across webhooks, so a webhook with a
  backlog does not take every slot from one with a single delivery, and a per-webhook rate limit applies.
- **The receiver being down is not the tick being down.** A failing receiver is a failed delivery, and the tick's
  health is unaffected. A store error in the sender fails the tick, as any store error does.

## Volume

The sender is a tick step sized for **operator-scale** volume: tens of events a minute across a handful of webhooks. On
a scheduler-only deployment the tick runs once a minute, so a delivery is sent up to a minute late (see
[limits.md](limits.md) section 1); an always-on worker with the in-process tick sends within its interval.

- A sustained event rate above what the sender sends (50 a pass by default, 60 a minute per webhook) grows the backlog
  until the 24-hour expiry fails it. Raise `QCLOUD_WEBHOOK_BATCH` and `_RATE_PER_MINUTE`, or narrow the subscription.
- **Fan-out or volume belongs in a delivery queue of your own**: a worker that consumes a job's completion and calls the
  receiver, on the SDK, with its own retry, concurrency and scaling. A webhook is the right tool for "tell the chat
  channel a job failed", not for "notify ten thousand customers".
