# Quickstart: install on Kubernetes with Helm

The Control API, the panel, the tick and your workers on any Kubernetes cluster, from one Helm chart. The chart and the two
images are published to ghcr.io by the [release workflow](../.github/workflows/release.yml) when a version is tagged. It runs
no database: you bring a Postgres 16 or later, and the chart takes its connection string from a Secret.

## What you need

- A cluster, `kubectl` and Helm 3.8 or later (OCI charts).
- A Postgres 16 or later the cluster can reach, and a database in it.
- An OpenID Connect provider that issues RS256 or ES256 JWTs, with a public client for the panel (authorization code with
  PKCE). The [deployment runbook](runbooks/deploy-gcp.md#sign-in) lists what the token must carry.
- Two host names for the ingress: the API cannot be mounted under a path, so the API and the panel each get one.

## 1. Create the database Secret

The chart never creates this Secret, so the password is not in your values or in the Helm release history.

> Not run: it writes to your cluster.

```bash notrun
kubectl create secret generic qelay-db --from-literal=url='postgres://USER:PASSWORD@HOST:5432/DB'
```

## 2. Install

Put your settings in a file. Every value, with its default, is in [charts/qelay/values.yaml](../charts/qelay/values.yaml).

```yaml
# values.yaml
database:
  existingSecret: qelay-db
  tls: unverified            # or "off" for a trusted private hop, or tlsCa with the CA bundle
oidc:
  issuer: https://idp.example.com
  audience: qelay
  jwksUrl: https://idp.example.com/.well-known/jwks.json
panel:
  oidc:
    clientId: qelay-panel
ingress:
  enabled: true
  className: nginx
  tlsSecretName: qelay-tls   # or leave it empty and terminate TLS elsewhere
  api:
    host: api.example.com
  panel:
    host: qelay.example.com
```

> Not run: it installs into your cluster, and no release has been published yet.

```bash notrun
helm install qelay oci://ghcr.io/chxisb/charts/qelay --version X.Y.Z -f values.yaml
```

A pre-install job runs `qcloud-api migrate` first, so the schema is current before the first pod starts; if it fails the
install fails and the job's logs are kept. Register the panel's redirect URI (`https://qelay.example.com/`) at your identity
provider, then open the panel.

With `transport.kind: postgres` (the default) workers poll the database, so nothing else is needed and a wake-up can be about a
second late. For Pub/Sub or SQS set `transport.kind` to `gcp-pubsub` or `aws-sqs` with `transport.gcpProject` or
`transport.awsRegion`, and give the pods cloud access with `serviceAccount.annotations` (workload identity or IRSA).

## 3. Add a worker

The workers are your own image, running the SDK's `Worker`. List each one and the chart gives it the database, namespace and
transport settings:

```yaml
workers:
  - name: orders
    image: ghcr.io/me/orders-worker:1.2.3
    replicas: 2
```

## Upgrading and rolling back

`helm upgrade qelay oci://ghcr.io/chxisb/charts/qelay --version X.Y.Z -f values.yaml` migrates first, and the new pods report
not ready until the schema is current, so the old ones keep serving. `helm rollback` does not run the migration job, and an
older build runs against the newer schema ([operations](operations.md#rolling-back)). A shipped migration is never edited.

## Next

- [Operations](operations.md): connection budget, upgrading, backups.
- [Quickstart: GCP](quickstart-gcp.md) or [AWS](quickstart-aws.md): Terraform in place of Kubernetes.
