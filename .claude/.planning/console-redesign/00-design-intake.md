# 00 — Design intake and map

**Status:** done · **Depends on:** none · **Touches:** .claude/.planning/console-redesign

## Goal
Know what the design is and how it lands on the panel, before any code changes.

## Steps
1. Read the artifact (canvas, stylesheet, nav helpers, Carebell tokens, the Components, Modals, States, Main, AddJob,
   Alerts, Auth and BulkAdd boards in full, and the other boards by structure).
2. Read the panel shell, primitives, tokens, routes, guards and the tests that name copy.
3. Write [DESIGN-MAP.md](DESIGN-MAP.md) and [CURRENT.md](CURRENT.md).

## Acceptance
- Every one of the 33 boards is in the map with a route, a panel file and a task.
- Every design element the panel cannot back is a numbered deviation with a reason.
- The one human gate (fonts) is named.

## Verify
```bash
test -f .claude/.planning/console-redesign/DESIGN-MAP.md && git status --short
```

## Risks / notes
- The remaining page boards were read by structure and will be read in full by the task that builds them.
- The logo asset is the existing mark in a tile (R2), so no brand gate was hit.

## Result
Done 2026-10-20. Map and spec written. Nothing in `packages/` changed. Boards read in full: Components, Modals, States,
Main, AddJob, Alerts, Auth, BulkAdd. The rest are read when their task starts.
