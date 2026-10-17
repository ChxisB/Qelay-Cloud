# Release checklist: v1.0.0

The steps **you** run to release. Nothing here has been run: no tag, no push, no publish and no version bump exists, and the
packages are `0.0.0` and `private`. Run the steps in order and stop at the first one that fails. Replace `<owner>/<repo>`
with the repository you create.

## 0. Decide first

None of these can be answered by a test.

1. **Workflows (D7): ship or cut.** The recommendation is to ship, with the caveats in [known issues](known-issues.md)
   (row 4 and the workflow limits). To cut: make `QCLOUD_API_WORKFLOWS=false` the default (it hides the Workflows page and
   refuses its routes; the engine stays in the SDK package, so decide whether to remove its export too), list workflows in
   [CHANGELOG.md](../CHANGELOG.md) as v1.1 work, then rerun step 1.
2. **Finding F-2** (a payload that decodes far larger than its bytes): cap decoded elements at enqueue, decode lazily in the
   list route, or accept it and document it. It is a medium finding and the security review is not complete until you choose.
3. **Custom-id replacement across queues** ([known issues](known-issues.md#1-open-and-waiting-for-the-owners-decision), row 2).
4. **Sign the Phase 1 and Phase 2 gates** (tasks 22 and 37) after reading their gate documents.
5. **Real clouds (D9).** Say whether a GCP project and an AWS account may be used for the first real runs. Until then every
   cloud result is an emulator result, and the changelog says so.
6. **The repository URL**, and whether to publish under the npm names `qelay-cloud` and `@qelay-cloud/*`. Both were free
   when checked (every name answered 404), but you must own the `@qelay-cloud` scope, and that cannot be checked without
   logging in to npm. Nothing has been reserved.
7. **Publish from CI or from your machine.** `provenance` needs a CI runner that npm supports and a workflow that does the
   publishing; none exists in `.github/workflows`. Publishing from your machine works without provenance.

## 1. Verify a clean checkout

On a clean clone, with Docker running:

```bash
bun install --frozen-lockfile
docker compose -f docker-compose.test.yml --profile sqs --profile pgbouncer --profile tls up -d --wait
QCLOUD_REQUIRE_DB=1 QCLOUD_REQUIRE_PGBOUNCER=1 QCLOUD_REQUIRE_TLS=1 QCLOUD_REQUIRE_SQS=1 QCLOUD_REQUIRE_PUBSUB=1 \
  bun run typecheck && bun run lint && bun run format:check && bun run architecture && bun test
bun run test:model && QCLOUD_MODEL_RUNS=500 QCLOUD_MODEL_COMMANDS=150 bun run test:model
bun run test:scenarios --transport=local,gcp-emulator,aws-emulator
bun run test:e2e && bun run docs:check && bun run security:routes --check && bun run notices --check
QCLOUD_REQUIRE_TERRAFORM=1 bun run check:terraform
```

The Pub/Sub emulator is started on the host (see [CLAUDE.md](../CLAUDE.md)). The compose file starts PostgreSQL 16, so this is
the first run of the database suites on 16: if the DDL snapshot or an `EXPLAIN` check differs, regenerate it with
`QCLOUD_UPDATE_SNAPSHOT=1`, read the diff, and commit it. The Firefox project of `test:e2e` is also run here for the first
time. Then, in each of `infra/gcp/example`, `infra/gcp/control-plane`, `infra/aws/example` and `infra/aws/control-plane`:

```bash
terraform init -backend=false && terraform validate
```

Build the two images (`packages/control-api/Dockerfile`, `packages/panel/Dockerfile`), scan them, and keep their SBOMs
(finding F-5).

## 2. Push and let CI run

```bash
git add -A && git commit -m "Qelay-Cloud 0.0.0"
git remote add origin https://github.com/<owner>/<repo>.git
git push -u origin main
```

`.claude/` (the plan, the completion notes and session files) is untracked and not ignored: decide whether it belongs in the
repository before `git add -A`. **Eight links in `docs/security/phase2-pass.md` and `docs/spikes/` point into
`.claude/.planning/v1.0.0/`**, so a clone without `.claude/` fails `docs:check` (and so the `gate` job) with "no such file or
folder". Either commit at least `.claude/.planning/`, or change those links first. `ci.yml` has never run, so expect to fix
forward on the first run. Wait for `gate`, `transports` and `terraform` to pass.

## 3. Bump the version

```bash
bun scripts/release-bump.ts 1.0.0 --repository=https://github.com/<owner>/<repo>            # dry run: prints what changes
bun scripts/release-bump.ts 1.0.0 --repository=https://github.com/<owner>/<repo> --apply
bun install
bun run notices --write
```

This sets the version in every package, takes `private` off every package but the panel, and adds `repository`, `homepage`,
`bugs` and `publishConfig` (public, provenance). Then set the date on the `1.0.0` heading of [CHANGELOG.md](../CHANGELOG.md),
rerun step 1's gate, and commit:

```bash
git commit -am "Release 1.0.0"
```

## 4. Tag and publish

```bash
git tag -a v1.0.0 -m "Qelay-Cloud 1.0.0"
git push origin main v1.0.0
```

Publish in dependency order, each from its own folder (`bun publish` replaces `workspace:*` with `1.0.0`; `bun pm pack` showed
that on the SDK). Run the first of each with `--dry-run` and read the file list:

```bash
for p in core store-postgres transport-local transport-gcp transport-aws transports sdk control-api maintenance telemetry; do
  (cd packages/$p && bun publish --access public) || break
done
```

The panel is not published: it ships as an image and static files.

## 5. Deploy

Follow the runbooks, in this order: [deploy-gcp](runbooks/deploy-gcp.md) or [deploy-aws](runbooks/deploy-aws.md). The release
step is `qcloud-api migrate`, before any service ([operations, upgrading](operations.md#upgrading)). The first deploy to a real
cloud is also the first real-cloud run: record in [limits section 8](limits.md#8-what-has-not-been-run) what it showed.

## Rollback

| What went wrong | What to do |
| --- | --- |
| A bad application revision | Serve the previous revision against the migrated database ([operations, rolling back](operations.md#rolling-back)). Do not run the older build's migration job. |
| A bad migration | Fix forward with the next version. A shipped migration is never edited ([operations](operations.md#upgrading)). |
| Lost or corrupted data | [Restore from backup](runbooks/restore-from-backup.md). |
| A bad npm release | `npm deprecate qelay-cloud@1.0.0 "<reason>"`, then publish 1.0.1. `npm unpublish` works only within 72 hours and only if nothing depends on it. |
| A wrong tag that nobody has used | `git tag -d v1.0.0 && git push origin :refs/tags/v1.0.0`. Once a version is published, do not move its tag. |
