# 05 — Control API and openapi: sources, requests, replay

**Status:** todo · **Depends on:** 02, 04 · **Touches:** packages/control-api, docs/openapi.yaml

## Goal
An operator manages sources, reads requests and replays one.

## Steps
1. `/sources` (list, create, read, patch, delete, rotate secret), `/requests` (list by keyset with status and source filters, read one), `POST /requests/{id}/replay` (re-evaluates the source's current routes). Writes need operator and are audited by the source id; a viewer sees a source's URL token cut and never a secret.
2. A route's create and read carry `source` (a source id) beside `queue`; the loop check treats a source as having no incoming edge.
3. `openapi.yaml` and the served routes match.

## Acceptance
- The openapi test passes; every new write is audited; a viewer gets 403 on writes and no secret anywhere (tests).
- Replay creates events only for currently enabled routes and none for a disabled source (test).

## Verify
```bash
QCLOUD_REQUIRE_DB=1 bun test packages/control-api test/docs
```

## Risks / notes
- Gate: new public routes; the owner approves the openapi diff.

## Result
