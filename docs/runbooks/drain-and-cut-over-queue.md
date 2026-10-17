# Runbook: drain a queue and cut it over

**When.** You are changing something workers must not see half-way: a handler that is not compatible with jobs already queued,
a move to another broker (the same namespace on `gcp-pubsub`, `aws-sqs` or `postgres`), or a retired queue.

**What is safe.** A pause stops new jobs from being taken; a job already running finishes. Nothing is removed. Jobs added while
paused wait. `resume` rings nothing itself: the tick rings what was held, within its interval.

## Drain

1. Stop new work from starting: `POST /queues/{queue}/pause`; confirm with `GET /queues/{queue}/paused`.
2. Let the running jobs finish: `GET /queues/{queue}/counts` until `active` is 0. A job that outlasts your patience can be
   left; its worker finishes it, or on a stop signal it is released after `graceMs` and runs again.
3. Decide what happens to the waiting jobs:
   - keep them (the new code will run them) - nothing to do;
   - remove them: `POST /queues/{queue}/drain` deletes the jobs that have not run. This cannot be undone. Read
     `counts` first, and do not use it as a way to hide a backlog you have not understood.

## Cut over

- **New handler code:** deploy the workers with the new code, then `POST /queues/{queue}/resume`.
- **A different broker:** the bells live in the broker, so change the broker on the tick, the workers and the API **together**
  (they must agree), with the new topics or queues in place first. Jobs are in Postgres, so nothing moves; after the switch
  the tick rings every claimable job on the new broker. Bells left in the old broker are never read again; delete them when
  you are done. Per-broker differences are in [transports.md](../transports.md).
- **Retiring a queue:** after it is drained, remove its topic or queue in Terraform. `POST /queues/{queue}/obliterate` deletes the
  queue and **all** its jobs: do not call it on a queue you have not drained and read.

## Verify

A test job added after the resume completes on the new code or broker; `GET /deployment` is `ok`; the old broker's depth no longer
changes.

Not run on a real cloud. The pause, drain and resume routes are covered by the Control API tests; a broker switch was
exercised only between the local transport and the emulators.
