# Task 34: Panel, provider wiring and capability gating (2026-10-15)

**Done locally. No cloud resource was touched.** The panel ran against the Control API on a local PostgreSQL 18.6 and the
in-process transport, in Chromium and WebKit. Firefox was configured but did not launch in this sandbox, and the new CI
`e2e` job has not run in GitHub Actions. OIDC was exercised with a fake client in unit tests, never against an identity
provider.

**Changed files**

- `packages/panel/src/lib/`: `panelConfig.ts`, `bootPanel.ts`, `errorBody.ts` (new); `auth/{oidc,session,authStore,activeSession}.ts`
  (new); `capabilities/{types,model,store,useCapabilities}.ts` (new); `api.ts`, `bq/{transport,targetClient,queueApi,serverApi}.ts`,
  `bqTypes.ts`, `demo/{api,install}.ts` (changed).
- `packages/panel/src/components/`: `AuthScreens.tsx`, `RouteGate.tsx` (new); `AuthGate.tsx`, `CommandPalette.tsx`,
  `layout/{AppLayout,Sidebar,Topbar,navConfig}` (changed). `src/pages/NotAvailable.tsx`, `pages/settings/SessionCard.tsx`,
  `pages/control/workers/SortButton.tsx` (new).
- `packages/panel/src/pages/`: role and capability gating in `CronManager`, `JobsPro`, `WorkersPro`, `Diagnostics`,
  `DlqControl`, `QueueControl`, `QueueDetailPro`, `QueuesOverview`, `JobInspector`, `Settings` and their children
  (`cron/CronTable`, `dlq/*`, `job/*`, `jobInspector/*`, `jobsPro/JobsTable`, `queues/QueuesTable`,
  `diagnostics/useDiagnosticActions`).
- `packages/panel/test/`: 12 new suites plus `oidc.helpers.ts`; `setup.ts`, `nav-shell`, `api-surface-complete`,
  `demo-api-complete`, `browser-e2e-policy` changed.
- `packages/panel/e2e/`: `runtime.ts`, `config.ts`, `networkPolicy.ts` replaced; `control-api.e2e.ts` new; the other specs
  and `fixtures.ts` unskipped and ported. `playwright.config.ts` (webServer, three projects), `package.json`
  (`oidc-client-ts` 3.5.0), `README.md`.
- Control API (one additive contract change): `packages/control-api/src/{types.ts,routes/unsupported.ts}`,
  `src/server.ts` (`stop(force?)`), `routes/capabilities.ts`, `docs/openapi.yaml`, `test/{capabilities,server,queues.boundaries}.test.ts`,
  `test/contract/shapes/schemas.ts`.
- Root: `package.json` (`test:e2e`), `.github/workflows/ci.yml` (`e2e` job, Chromium).
- `docs/PORTING.md` ("Panel wiring (task 34)", e2e section, feature triage), task file (Result, status), `CURRENT.md`
  (row 34, 25 of 42).

**Checked**

- `bun run typecheck && bun run lint && bun run format:check && bun run architecture`: exit 0 (lint reports the carried
  panel warnings).
- `bun test packages/panel`: 1,175 pass, 0 fail (205 files).
- `QCLOUD_REQUIRE_DB=1 bun test packages/control-api test/contract`: 449 pass, 12 skip (Pub/Sub emulator), 0 fail.
- `bun run test:e2e --project=chromium`: 18 passed. WebKit: 18 passed.
- `bun run test:model` not run: no queue semantics changed.

**Measured**

- e2e: 18 specs: 13 of the 15 upstream specs (one trimmed of its SQLite step), the benchmark and webhook specs removed,
  5 new in `control-api.e2e.ts`; about 29 s on Chromium.
- Files that differ from the upstream commit under `src/`, `shared/`, `test/` and `e2e/`: 55 changed and 23 added, each
  named in `docs/PORTING.md`.

**Decisions**

- Library: `oidc-client-ts` 3.5.0 (authorization code + PKCE). Tokens in memory; PKCE/state in `sessionStorage` (no token).
- A stable opaque `session-<hex>` handle lives in the connection store; one fetch wrapper swaps it for the live token for
  URLs under the pinned API address only.
- `/config.json` has no secrets by construction: strict schema, secret-like key names refused, https authority except
  loopback.
- Capabilities fail closed (hidden pages hidden, caller a viewer) until the server answers.
- New hidden name `queueOperations` (additive): Queue Control's agent-backed card is left out and the Control API answers
  501 under `/queue-operations/*`.
- "Retry a failed job" is asserted as absent plus a 501 for a forced `move-to-wait`, since `job-retry` is `unsupported` on
  this transport (task 31).
- e2e runs in token (dev static token) mode; OIDC is unit-tested with a fake client.
- `*-classic` pages stay URL-reachable and are not role-aware; the server is the authority.

**Found and fixed**

- Upstream DLQ page offered "Retry all" and Purge to everyone: gated by `useDlqMutations()` (role and `dlq-retry`).
- A cached `/queues/summary` hid a directly seeded queue and degraded the Alerts spec; the e2e runtime sets
  `summaryCacheMs: 0`.
- A graceful `stop()` was held open by SSE streams, which stalled the reconnect spec: `stop(force)`.
- The route changed before the lazy page chunk rendered, so specs clicked on a page that was not there yet:
  `visit()` waits for the page heading.
- Queue Control called `localhost:6800` and failed with connection refused: the `queueOperations` capability above.

**Owed**

- Hide or serve Benchmark's worker leg (`pull-batch`, `ack-batch`).
- Copy pass: "Bunqueue v2.9.3" wording (46 files), footer and command-palette links, `VITE_BUNQUEUE_*` names, the
  "Control agent · localhost:6800" sidebar line and Settings "Fleet connections".
- Enable DLQ Purge for operators (the API supports it with `confirm`).
- Firefox e2e and the CI `e2e` job's first run.
- OIDC against a real provider and a deployed `/config.json` (D9 and task 36/37).
- The 120 React-compiler lint warnings.
- The upstream panel working tree had 385 modified and about 25 untracked uncommitted files beyond the copied commit
  `8ebf932`; none are in this copy.
