# Runbook: the tick has stopped

**Alert.** GCP: "<name>: tick not running" (the scheduler job logged no attempt) or "<name>: tick calls failing". AWS: `<name>-tick-stalled`.
Panel and `GET /deployment`: warning `tick_stale`, `tick_never_ran` or `tick_late`.

**What is safe.** Nothing is lost: every job is a row in Postgres. Workers keep taking the bells that were already rung and
`add` keeps ringing. What stops is the repair work: lost bells are not rung again, a crashed worker's jobs stay active until
the tick recovers them after their lease, cron entries do not fire, delayed jobs past the broker's window are not promoted,
retention does not run, webhooks are not sent. It is safe to run the tick by hand at any time; two may overlap.

## Check

1. What the deployment says (the API address and token are in the [index](README.md#before-you-start)):

   ```bash
   curl -s -H "Authorization: Bearer $TOKEN" "$API/deployment" | jq '{tick, warnings}'
   ```

   `tick.state` is `never`, `late`, `stale` or `unknown`. `lastFailureAt` newer than `lastSuccessAt` means the tick runs and
   fails; both old means it is not being called.
2. Is something calling it? (On AWS the schedule may be `rate(N minutes)` on purpose: the alarm then waits three periods, and a
   deployment whose workers run the tick in process is not stalled between scheduled ticks.)
   - GCP: `gcloud scheduler jobs describe <name>-tick --location REGION` shows `state` (`PAUSED` is the cause) and
     `status` / `lastAttemptTime`.
   - AWS: `aws scheduler get-schedule --name <name>-tick --query State` is `DISABLED` when the schedule was created with
     `scheduler_enabled = false`. Runs that were started are tasks of the `<name>-tick` task definition; a stopped one has an
     exit code and a reason in `aws ecs describe-tasks`.
3. If it is called and fails, read its log: GCP `gcloud run services logs read <name>-tick --region REGION`, AWS the tick's
   log group (the line has `"ok": false`). The usual causes:
   - the scheduler's token is refused (401/403): the scheduler's audience or service account differs from the tick's
     `QCLOUD_TICK_AUDIENCE` / `QCLOUD_TICK_ALLOWED_EMAILS` (Terraform asserts they match; a hand edit breaks it);
   - the database is unreachable or out of connections: [connection exhaustion](connection-exhaustion.md);
   - the broker refuses the ring (IAM, a deleted topic or queue): the report counts `unreachable` or `rejected`, and
     `/deployment` shows `transport_unreachable`.

## Fix

- Paused or disabled: `gcloud scheduler jobs resume <name>-tick --location REGION`; on AWS set `scheduler_enabled = true`
  and apply.
- Run it now instead of waiting a minute: `gcloud scheduler jobs run <name>-tick --location REGION`, or on AWS start the
  tick task (see the migration task in [deploy-aws](deploy-aws.md#running-the-migration) for the `run-task` shape, with the
  `<name>-tick` task definition and the command `run`).
- A large backlog drains over several invocations: one invocation repeats passes until `QCLOUD_TICK_MAX_RUN_MS`, and the next
  call carries on.

## Verify

`GET /deployment` shows `tick.state` `ok` with a small `ageMs`, and the `doorbells_overdue` warning is gone. The alert closes
by itself once a tick succeeds.

## Escalate

The tick succeeds but `moreWork` stays true for many minutes, or jobs stay unrung with the tick healthy: read
[doorbells piling up](doorbells-piling-up.md).
