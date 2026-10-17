# Runbook: rotate the database secret

**When.** On a schedule, after a suspected leak, or when someone who could read the URL leaves. The steps themselves are in the
deployment runbooks, because they are Terraform commands per cloud:

- GCP: [rotating the database secret](deploy-gcp.md#rotating-the-database-secret)
- AWS: [rotating the database secret](deploy-aws.md#rotating-the-database-secret)

**What is safe.** Connections already open stay open. A process that reconnects with the old password fails until its new
revision serves, which is minutes. The SDK retries with backoff, the tick repairs the gap, and no job is lost. A
rotation is **not** safe to start while the tick or a migration is the only thing keeping a backlog moving; do it when the
[deployment](../operations.md#what-to-watch) is healthy.

## Before

`GET /deployment`: `database.state` `ok`, `tick.state` `ok`, no `connections_*` warning. A rotation spends connections twice for a
while (old and new revisions overlap), so check [the budget](connection-exhaustion.md) has room.

## Do

Follow the cloud's section above. In order: the data plane (which sets the password and rolls the workers and the tick), then
the control plane (which rolls the API; the migration job reads the new version on its next run). Pooler credentials rotate
separately.

## Verify

For ten minutes after: `GET /deployment` stays `ok`; no worker logs authentication failures; `qcloud.worker.claim_failed` is flat; the
[tick](tick-stopped.md) reports `ok`. Then disable or delete the old secret version.

## If it goes wrong

Authentication failures that last past the rollout mean a service is pinned to an old secret version: check which version each
service reads and re-apply. A password the database no longer accepts cannot be recovered from the previous secret
version; reset the user's password in the cloud console to the value in the current secret.

Unproven until it has run against a real project or account (D9). The game day changes the password of a throwaway role on the
local Postgres and shows the three claims above: connections already open keep working, a process that has to log in again
fails until it has the new password, and no job is lost. The secret-manager and Terraform steps were not run.
