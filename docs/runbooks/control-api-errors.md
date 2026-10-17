# Runbook: the Control API returns 5xx

**Alert.** The "<name>: control API errors" policy on GCP (Cloud Run request count with a 5xx response class) and the load balancer's
target-5xx alarm on AWS. The panel shows errors, or loads blank.

**What is safe.** The Control API only reads and edits rows and rings bells after the commit. Workers and the tick do not depend
on it: jobs keep running while it is down. Restarting it is safe.

## Check

1. Is it up and ready? `GET $API/health` (public) is 200 when the process is alive; `GET $API/health/ready` (needs a token) is 503
   with the reason when the schema is `behind` or the database cannot be reached ([failed migration](failed-migration.md)).
2. What does it say: its structured log has one line per request with the status and `requestId` (never a body or a token).
   GCP `gcloud run services logs read <name>-api --region REGION`; AWS the service's log group.
3. Common causes: the database is unreachable or out of connections ([connection exhaustion](connection-exhaustion.md)); a revision
   that cannot read a secret; a release that needs a migration that has not run; the identity provider's keys are unreachable
   (4xx 401, not 5xx).

## Fix

- A bad revision: send traffic back to the previous one ([GCP](deploy-gcp.md#rolling-back), [AWS](deploy-aws.md#rolling-back)).
  The older build stays ready against a newer schema.
- Schema `behind`: run the migration job.
- Database: see the two runbooks above.

## Verify

`/health/ready` is 200, the error rate returns to zero for ten minutes and the alert closes.
