# 08 — Api issues

**Status:** done · **Depends on:** 07 · **Touches:** packages/control-api, docs/openapi.yaml

## Goal
`GET /webhooks/issues` and `PUT /webhooks/issues/{id}` (status), audit rows, and Home warnings that honour ignore.

## Steps
1. Routes, strict body, wire shape, openapi, route docs, audit `webhook-issue=<id>`.
2. `ops/warnings.ts` leaves out an ignored issue and an operator hold.

## Acceptance
- The list filters by status and pages; counts per status are in the answer.
- A status change is operator-only and audited with ids.
- An unknown id is a 404; an illegal change (resolved to anything) is a 409.

## Verify
```bash
bun test packages/control-api
```

## Risks / notes


## Result
GET /webhooks/issues (status default open, webhook, limit, before; answers issues, next and the count of every status; each issue carries the route name, streak, alertLevel and pausedBy; updatedBy is null for a viewer) and PUT /webhooks/issues/:id (strict {status}, operator-only, audited with id=<n> only, 404 issue_not_found, 409 issue_resolved, a malformed id or status is a 400). Home warnings (ops/deploymentView.ts): webhook_paused now counts only routes the failure streak paused (an operator hold has a disabledReason too and is not a fault), and neither warning counts a route whose live issue is ignored (one extra bounded read, settled; if it fails the warning errs toward showing). New files: jobs/webhookIssueModel.ts, routes/webhookIssues.ts, test/webhooks.issues.test.ts (11 tests); openapi paths and schemas, openapi.webhooks.test.ts fit check, docs/reference/routes.md and docs/security/routes.md regenerated. Ran on local PG 18: control-api 699 pass 0 fail; typecheck, oxfmt, oxlint (existing panel warnings only), architecture, docs:check clean. A mutation of the counting logic made the two Home tests fail, then was restored. Not run: playwright, Docker-backed suites.
