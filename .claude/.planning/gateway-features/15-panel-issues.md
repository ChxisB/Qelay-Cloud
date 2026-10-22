# 15 — Panel issues

**Status:** done · **Depends on:** 12 · **Touches:** packages/panel/src/pages/control/gateway

## Goal
Issues has Open, Acknowledged, Resolved and Ignored tabs with counts, and an action per issue.

## Steps
1. Replace the derived list with the server's; actions call the status route; polling and the guard as elsewhere.

## Acceptance
- Each tab lists only its status; an action moves the issue and the counts.
- A failed action says why and changes nothing.
- An older server falls back to the derived list.

## Verify
```bash
bun test packages/panel/test
```

## Risks / notes


## Result
Issues now reads GET /webhooks/issues: tabs Open, Acknowledged, Resolved, Ignored (address ?status=, unknown values mean Open) with the server's count of every status, one IssueCard per issue (route name and line, streak, paused-after-failures, opened/changed times, who last changed it when the server tells), and for an operator Acknowledge / Ignore / Resolve / Reopen per status (a resolved issue has none, it is history) plus Resume connection when the connection was paused by failures. useIssueActions sends PUT /webhooks/issues/:id under the registry-write guard; a refusal shows the server's words and changes nothing, and issue_resolved or issue_not_found also re-read the list. A viewer has no buttons. A server from before issues (404 or 405 on the issues route) gets the old derived list (DerivedIssues.tsx) and no tabs. Page size is the API maximum 200 and the screen says when more exist; there is no paging control. Tests: gateway-issues.test.tsx (12 tests) and the three old Issues tests, which now cover the older-server fallback. Ran: full panel suite 1771 pass 0 fail, typecheck, format:check, architecture, lint (exit 0, warnings only). Not run: Playwright, a real server. Known gap: the Home page still counts issues from the connections' failure counts, so after an acknowledge or ignore it can disagree with the Open tab.
