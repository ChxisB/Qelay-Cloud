# Release workflow and Helm chart (2026-10-19)

Asked for: a release workflow that publishes Docker images and a Helm chart so an install is one `helm install`.

## Built

- `charts/qelay/`: Chart.yaml (0.0.0, the release sets version and appVersion from the tag), values.yaml, templates for the API
  (Deployment, Service), the panel, a `pre-install,pre-upgrade` migrate hook Job, the tick (loop Deployment, once-a-minute
  CronJob, optional webhook sender), a `workers:` list, an optional Ingress and a ServiceAccount. `ci/values.yaml` turns every
  feature on for lint and render.
- `.github/workflows/release.yml`: on `vX.Y.Z[-pre]`: guard (tag is on main), CI (`ci.yml` now has `workflow_call`), then
  `qelay-api` and `qelay-panel` (amd64 and arm64, SBOM, max provenance) to ghcr.io, then the chart (OCI) and a GitHub Release.
- `ci.yml`: a `chart` job (`helm lint` and `helm template`).
- `docs/quickstart-kubernetes.md`, README row, release-checklist paragraph, `charts` in `.dockerignore`.

## Decisions

- The database Secret is `database.existingSecret` only. A hook runs before the release's own resources exist, so a chart-made
  Secret would need hook ordering, and a URL in values lands in the Helm release history.
- Default `transport.kind` is `postgres` (no cloud account needed); the docs say it polls and is up to about a second late.
- Migration is a Helm hook, so `helm rollback` never runs an older build's migration (operations, rolling back).
- The tick is the API image with `command` overridden, as in the Terraform; the CronJob is the chart's Cloud Scheduler.

## Run

`helm lint`, `helm template` (full values, minimal values, `panel.enabled=false`, three `required` failures), `helm package`,
`bun run docs:check --no-run`, `bun run format:check`, both workflows parsed as YAML.

## Not run (owed)

- No image was built and nothing was installed on a cluster (disk had 2.9 GiB free; Docker deferred). `readOnlyRootFilesystem`
  with a `/tmp` emptyDir, the probes, and the tick `command` override are unverified until a `kind` install of a built image.
- The workflows have never run on GitHub; action SHAs were resolved from each action's latest release.
- No `actionlint`. First tag should be a pre-release (`v1.0.0-rc.1`).
- After the first push, set the three ghcr packages to public by hand.
