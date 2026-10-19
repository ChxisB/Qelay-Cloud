# R20: what the review said to borrow from a comparable queue server

Date: 2026-10-19. Tracker: `.claude/.planning/review-2026-10-19/CURRENT.md`.

## What changed

- **Admission control.** `ResilientPool` counts store operations in flight (running or waiting for a connection). One more than
  `maxInFlight` is refused at once with the new `StoreOverloadedError` (`STORE_OVERLOADED`), before anything is sent, so it is safe
  to retry. The option is on `openDatabase` (`ConnectionOptions.maxInFlight`), default 64 per pooled connection (128 at the default
  pool of 2), and the Control API maps the error to `503 store_overloaded`. No environment variable. The number is chosen, not
  measured.
- **Database timeouts.** Both clouds set `statement_timeout` 30 s, `lock_timeout` 5 s and `idle_in_transaction_session_timeout`
  30 s on the server (GCP `database_flags`, AWS parameter group and cluster parameter group, applied at once). The variable is
  `session_timeouts` on each database module and `database_session_timeouts` on each example: `{ statement_ms, lock_ms,
  idle_in_transaction_ms }`, 0 turns one off, negative or fractional values are refused. They are server settings, so they work
  behind a pooler, where a startup parameter cannot carry them.
- **Migrations and the statement timeout.** The migrator runs `set_config('statement_timeout', '0', true)` inside its own
  transaction, after the advisory lock, so a slow index build is bounded by the migration deadline and not by the 30 s. The
  `lock_timeout` stays, so a DDL that cannot lock gives up and the release step is retried. No migration was added or edited.
- **Metric cap.** Not built, because nothing needs it: no metric carries a queue name, a job name or an id (the tags are `reason`,
  `operation`, `at`, `result`, `step` and `error.type`), so the number of series does not grow with the number of queues. The rule is
  now written in `docs/observability.md`, with what a per-queue series would need first (a bound and an "omitted" gauge).
- **Alert list.** Compared with the usual list, in `docs/observability.md` ("The alerts against a usual list"): dead letters, no
  workers and backlog (as age) are covered. Not shipped, with the reason beside each: worker slot use (the SDK reports none), stuck
  jobs and a failure rate (the shipped tick exports no gauges), a stale backup (no backup-age metric that could be checked here).
  `docs/known-issues.md` points at the table.
- **Panel rule.** "Disable what cannot be done safely" is a stated rule in `packages/panel/README.md`, with the test for it and the
  place it lives (`shared/flowOperationPolicy.ts`). It says plainly that only active jobs explain the reason.
- **Firefox.** The nightly workflow gains a `browsers` job (Firefox and WebKit, `bunx playwright install --with-deps`, Postgres 16
  service). Pull requests still run Chromium only. `docs/known-issues.md` and the panel README say that no Firefox spec has run.

## Verify

- New tests: `connection.admission.test.ts` (an operation over the limit is refused and frees its place when others finish or fail;
  the default is 64 per pooled connection), `schema.migrate.test.ts` (a migration that sleeps 0.4 s passes under a 100 ms server
  `statement_timeout`; it fails without the `set_config` line), the `STORE_OVERLOADED` row of `control-api/test/errors.test.ts`,
  and the default in `connection.options.test.ts`.
- `check:terraform` (plan only, terraform 1.5.7, no credentials): GCP 204, AWS 863, GCP control plane 131, AWS control plane 2665
  checks pass. New: the three server timeouts on the GCP flags, on the AWS instance group and on the AWS cluster group; a negative
  timeout refused on both.
- `terraform validate` passes in both examples; `terraform fmt -recursive infra`, `docs:check`, `format:check`, `architecture`,
  `typecheck` pass; `lint` has only the existing panel warnings.
- Package suites on scratch PostgreSQL 18.6: see the tracker's R20 paragraph for the counts.

## Not done / owed

- **No real cloud.** No database was created with the timeout flags: whether Cloud SQL and RDS accept all three, and that they take
  effect on a running instance without a restart, is read from the documentation of the flags, not run (D9).
- **Firefox did not run.** Playwright's Firefox 153 was installed and still cannot start in this session's sandbox
  (`sandbox_extension_issue_file_to_process failed … Operation not permitted`). The sandbox was not bypassed. The nightly job has
  never run (no GitHub Actions run exists).
- **The alerts not shipped** (worker slot use, stuck jobs, failure rate, stale backup) stay open. The first three need the SDK or the
  tick CLI to export metrics; the fourth needs a check against a real Cloud SQL or RDS.
- **`maxInFlight` is not tunable from the environment** and was not measured against a stalled database under load. A worker whose
  completion is refused reports an unconfirmed outcome and the tick recovers the lease; completions are not given priority over
  claims.
- The 30 s statement timeout also applies to the tick's own passes and to a long Control API operation such as obliterating a very
  large queue; neither was measured against it. A one-off long statement run by hand needs `SET statement_timeout = 0`.
