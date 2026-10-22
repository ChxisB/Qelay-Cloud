# 13 — Panel connections

**Status:** done · **Depends on:** 12 · **Touches:** packages/panel/src/pages/control/gateway

## Goal
Connections shows a 24 h count and trend on every row from one grouped read, and the name.

## Steps
1. `useGatewayStats` gets a grouped read; rows and the table show them; a connection with a name shows it first.

## Acceptance
- One stats call for the list, not one per row.
- An older server (no groupBy) leaves the numbers out and the list works.

## Verify
```bash
bun test packages/panel/test
```

## Risks / notes


## Result
Connections: one grouped read (useGroupStats, GET /webhooks/stats?groupBy=webhook&buckets=24 over 24 h) gives every row a 'Last 24 hours' cell (hourly bars, red where something failed, share failed, an aria-label with the counts); a server that cannot group leaves the column out and the list works (the grouped parse fails quietly, the error is ignored). The connection name leads the row, the connection page heading, the event feed owner, the event detail, the home issue line and the route selects (routeName/routeLine in model.ts, no name reads as before); search finds it; Delay and Deduplicated join the rule chips. Tests: gateway-connections-trend (5), gateway-model (+2). Ran: panel suite, typecheck, oxfmt, oxlint exit 0, architecture. Not run: real server, Playwright. Note for 14: routeState still reads disabledReason !== null as 'paused after failures', so an operator hold would show as that until 14 switches it to pausedBy.
