# 07 — Migration 18 issues

**Status:** done · **Depends on:** 06 · **Touches:** packages/store-postgres

## Goal
Migration 18: `qcloud_webhook_issues`, opened and resolved by the recording path, with list and status calls.

## Steps
1. `schema/ddl/webhookIssues.ts`: one live issue per webhook (a partial unique index), a backfill of routes failing or paused for failing now.
2. `webhookIssues.ts`: `list(status, limit, before)`, `setStatus(id, status, by)`, counts.
3. `webhookRecord.ts` opens an issue on a failed delivery and resolves on a success, set-based.

## Acceptance
- A failed delivery opens one issue and a second does not make another.
- A success resolves the live issue, whatever its status.
- `ignored` and `acknowledged` survive more failures and still resolve on recovery.
- A manual resolve that is followed by a failure opens a new issue.
- A held route makes no issue.
- Deleting the route deletes its issues.

## Verify
```bash
QCLOUD_REQUIRE_DB=1 bun test packages/store-postgres
```

## Risks / notes
A hot path: one extra statement per record batch, measured in task 17.

## Result
Migration 18 qcloud_webhook_issues (new table, partial unique live index, status and resolved indexes, backfill of failing or paused-for-failing routes); core webhookIssue.ts; store issues/issueCounts/setIssueStatus; settleIssues in the record transaction (last settled delivery per route decides; held routes open none); resolved issues pruned past webhookKeepMs. 12 store tests (hold guard mutation-checked) and a backfill test via migrate({migrations}); snapshot regenerated and diff reviewed; 6 planned-query rows. Ran on local PG 18: store-postgres, maintenance, core 2376 pass, 1 fail in a real-timer tick-lateness test that passes alone twice (load flake); typecheck, oxlint, format:check, architecture clean. Old workers record no issues (noted in the DDL). Cost of the extra statement per record batch is not measured yet (task 17).
