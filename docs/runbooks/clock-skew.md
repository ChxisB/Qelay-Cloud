# Runbook: clocks disagree

**Signal.** The control API rejects tokens that should be valid ("expired" or "not yet valid"), webhook receivers complain about
timestamps, or the ages in the panel look wrong by a fixed amount.

**What is safe.** The queue itself does not depend on your hosts' clocks. Delays, leases, the tick's own age, retry backoff and
cron are measured on the **database's clock** (`now()` in the statement), so a worker with a wrong clock does not run delayed
jobs early or take another worker's lease. The tick's age in `GET /deployment` is the database's clock too.

What does read a host clock:

| Thing | Where | Effect of skew |
| --- | --- | --- |
| OIDC token `exp` / `nbf` | the Control API | tokens rejected; `QCLOUD_API_OIDC_CLOCK_TOLERANCE_SEC` (default 30) is the allowance |
| The scheduler's identity token | the tick | 401 on the tick, which then does not run: [the tick has stopped](tick-stopped.md) |
| Webhook signatures carry a timestamp | the receiver | the receiver's replay window rejects them |
| Ages shown for broker numbers | the Control API | the broker's reading time against the API host's clock: a few seconds, cosmetic |

## Check

1. Which host: compare `date -u` on the failing host with the database (`SELECT now()`). Cloud Run, Fargate and managed
   Postgres keep time with the provider's NTP, so a managed host skewed by minutes is rare; a developer machine or a VM you run is
   the usual one.
2. The Control API log shows the token error class (never the token).

## Fix

- Fix the host's time source (NTP / `chrony`, the VM's guest time sync). Do not widen the tolerance beyond a minute to hide a
  bad clock: it widens the window in which a stolen expired token is accepted.
- If the receiver's clock is the skewed one, fix that clock; the sender cannot compensate.

## Verify

Tokens validate again, the tick runs, and `GET /deployment` shows `tick.state` `ok`.
