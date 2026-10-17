# 34 — Panel: provider wiring and capabilities

**Status:** done locally · **Depends on:** 31, 32, 33 · **Phase:** 2

## Goal

Point the panel's `src/lib/bq/*` clients at the Control API, authenticate with OIDC, and hide the pages that do not apply to a managed-cloud deployment, using `/capabilities`.

## Scope

In: base URL and auth in the client layer, capability gating of navigation and routes, error handling for `501 not_supported`, removal or hiding of Server Control, SQLite Database, S3 Backup and Fleet.
Out: new Transport and Deployment pages (35), flows and workflows (51, 62).

## Steps

1. **Client layer:** a single `ApiClient` in `src/lib/bq/` that adds the bearer token, handles 401 (re-auth), 403 (permission message), 409 (stale version → refetch and prompt) and 501 (not supported → neutral empty state). Base URL from runtime config (`/config.json` loaded at start so one build serves every environment).
2. **Auth:** OIDC authorization-code flow with PKCE using a small, audited library (record the choice); tokens in memory only (not `localStorage`); silent refresh; sign-out. The dev static token mode is available only when the Control API runs in dev mode.
3. **Capabilities:** fetch `/capabilities` once at start; a `useCapabilities()` hook; navigation items and routes are generated from the capability set. A direct URL to a hidden page shows a "not available in this deployment" page, not a blank or broken screen.
4. **Pages affected:**
   - hide **Server Control**, **SQLite Database**, **S3 Backup**, **Fleet** when listed in `hidden`;
   - keep **Dashboard, Queue Control, Add Job, Job Inspector, DLQ, Cron Manager, Workers, Diagnostics**;
   - show **Flows** and **Workflows** only when `features.flows` / `features.workflows` are true.
5. **Role-aware UI:** `viewer` sees no mutation buttons; `operator` sees them. The server remains the authority; this is a usability layer only.
6. **Destructive actions:** keep the panel's confirm-by-typing dialogs and send the `confirm` field expected by the Control API (task 31). Send `expectedVersion` on job actions.
7. **Real-time:** switch the live feed to the new SSE endpoint with `Last-Event-ID` resume and visible reconnect state.
8. **Tests:** unit tests for the client's status handling; component tests for capability gating (a page appears or disappears with the capability); an e2e run of the main flow against a locally running Control API, local transport and Postgres: add a job, see it, pause the queue, retry a failed job, create a cron.

## Acceptance

- With a local stack (Postgres, Control API, a worker), the e2e flow passes in Playwright.
- Pages for hidden capabilities are absent from navigation and show the "not available" page on direct URL.
- Tokens never appear in `localStorage`, `sessionStorage`, URLs or console logs (test).
- A `viewer` user cannot trigger a mutation, and the server rejects it if forced (e2e).

## Verify

```bash
bun run typecheck && bun run lint && bun run format:check && bun run architecture
bun test packages/panel
bun run test:e2e
```

## Risks / notes

- Auth code is security-sensitive; use a maintained library and do not roll your own PKCE.
- The panel's existing pages assume Qelay's server concepts in places (for example, "server uptime"). Each such place needs a capability-aware empty state, not a hidden crash; grep the pages for them and list the findings in the Result.
- Runtime config via `/config.json` avoids per-environment builds. Do not inline secrets into it.

## Result

**Done locally (2026-10-15). No cloud resource was touched.** The panel runs against the Control API on a local
Postgres 18.6 and the in-process transport; no Pub/Sub, no identity provider and no `terraform` were involved.

**What the panel does now**

1. **One client.** `src/lib/api.ts` and `src/lib/bq/` go through one fetch wrapper. The base URL comes from the runtime
   `/config.json` (`apiBaseUrl`, default `/api`). 401 re-authenticates, 403 says the role is not enough, 409
   `version_conflict` re-reads the job and asks again, 501 `not_supported` is a neutral "Not available in this
   deployment" state (never a crash).
2. **Sign-in.** `auth.mode` is `token` (a pasted bearer token, which is the Control API's development mode) or `oidc`
   (authorization code + PKCE, silent renewal, sign-out). Library: **`oidc-client-ts` 3.5.0**, a maintained OIDC/PKCE
   client; no PKCE code is written here. Tokens stay in memory (`InMemoryWebStorage`); the PKCE/state record is in
   `sessionStorage` for the length of a sign-in and holds no token. The connection store holds an opaque
   `session-<hex>` handle, and one fetch wrapper swaps it for the live access token for URLs under the pinned API
   address only, so a token cannot be sent to another origin by a page that builds its own URL.
3. **Capabilities.** `/capabilities` is fetched once per connection (`useCapabilities()`); until it answers, and after a
   failure, the panel assumes the closed side (hidden pages hidden, caller a viewer) and retries quietly three times.
   Navigation, the command palette and the routes come from it; a direct URL to a closed page shows
   "Not available in this deployment".
4. **Pages.** Server Control, SQLite Database, S3 Backup and Fleet are hidden when listed under `hidden`; Dashboard,
   Queue Control, Add Job, Job Inspector, DLQ, Cron Manager, Workers and Diagnostics stay; Flows and Workflows follow
   `features.flows` and `features.workflows`.
5. **Roles.** A `viewer` is shown no control that changes anything; pages that exist only to mutate (Add Job, bulk
   add, Queue Control, Benchmark, DLQ control, Webhooks) say "Operator role needed". A control for an action the
   deployment closes (`unsupported`) is left out. The server stays the authority and answers 403 for a forced request.
6. **Destructive actions** keep their typed-confirmation dialogs and send `confirm`; job actions send
   `expectedVersion`.
7. **Live feed** is the Control API's SSE `GET /events` with `Last-Event-ID` resume and a visible reconnect state. That
   part of the upstream client already did this; the e2e restarts the API to prove it.
8. **Tests.** Unit (status handling, config, OIDC with a fake client, session wrapper, no-leak), component
   (capability gating, viewer gating, route gate, navigation), and Playwright against the real stack (below).

**One additive contract change.** Queue Control embeds a card that calls the upstream *agent* (`/queue-operations/*` on
`localhost:6800`), not the Control API. Leaving it would show a connection error on a page the task says to keep. The
Control API now lists a fifth name, `queueOperations`, under `hidden` in `GET /capabilities`, answers 501
`not_supported` under `/queue-operations/*` like the other four, and the panel leaves the card out. Changed:
`packages/control-api/src/{types,routes/unsupported}.ts`, `docs/openapi.yaml`, their tests. Nothing else in the
contract moved; a client that does not know the name ignores it.

**Decisions**

- **Config file, not build variables.** `config.json` has a strict schema, refuses unknown keys, refuses any key named
  like a secret (`secret`, `password`, `token`, `api key`, `private`, `credential`) and refuses a non-https
  `authority` except on loopback. A missing file means development defaults; a wrong file stops the start-up with
  the reason. `VITE_BUNQUEUE_URL` and `VITE_BUNQUEUE_AGENT_URL` keep their upstream names (finding below).
- **The OIDC callback URL carries a single-use authorization code**, which the library removes from the address with
  `replaceUrl` as soon as it has exchanged it. That is the one place a credential is in a URL, and it is not a token.
- **A 15 s renew-loop guard** stops a provider that issues already-expired tokens from being hit in a tight loop.
- **`*-classic` routes** stay reachable by URL and are not role-aware (they are off-navigation, upstream's first
  generation); the server is the authority and a refused action shows the 403.
- **Retry a failed job** (step 8 of the plan) is not offered: `job-retry` is `unsupported` on this transport, by design
  (task 31). The e2e asserts the button's absence and the 501 of a forced `move-to-wait`. A cron is created and
  deleted, with its typed confirmation, in the `dashboard` spec on the same stack.
- **e2e runs in token mode** (the Control API's development token, refused when `production`). OIDC against an
  identity provider is not driven by a browser here; it is covered by unit tests with a fake client.
- **`stop(force)`** was added to the Control API's `RunningServer`: a graceful stop is held by open SSE streams, so the
  e2e restart (and, for task 37, the process entrypoint) must drain then force.
- The e2e runtime sets `jobs.options.summaryCacheMs: 0`: the specs enqueue behind the API's back, and the 5 s summary
  cache hid a queue that had just been seeded.

**Findings: Qelay server-concept assumptions in the pages** (the task's grep)

- **"Bunqueue v2.9.3" wording** is in 46 source files (flow-safety messages, `api.ts`, `bq/queueApi.ts`,
  `bq/jobPayload.ts`, `upstreamPaths.ts`, `WorkersPro` confirmation, `DlqConfigForm`, `QueueConfig`, `cron/model.ts`,
  `CronForm`, `JobDataEditor`, `JobActionsPanel`) and many tests assert it. Left unchanged: a copy pass is its own task.
- **DLQ Retry and Purge buttons stay disabled** by the upstream flow-safety copy, though the Control API purges with
  `confirm`. A follow-up can enable Purge for operators.
- **Diagnostics "Uptime"** comes from `/health`; it is the API process's uptime, not a server's. Labelled as such is
  left to the copy pass.
- **The sidebar shows "Control agent · localhost:6800"** and Settings has "Fleet connections" with an agent URL and
  token. The agent is only used by queue operations (now hidden), flows and workflows (tasks 51, 62). MCP, Benchmark,
  Usage, Logs, Alerts and Metrics do not call it. The separate `agentToken` is the only thing ever sent to it; the
  Control API token never is.
- **Benchmark** is still in the navigation, and its worker leg calls `pull-batch` and `ack-batch`, which the Control
  API does not serve. Its producer leg works. Left in place; whether to hide it is an open question below.
- **Footer and command palette** link to the upstream repository and docs; `X-Bunqueue-Db-Export-*` headers and the
  "bunqueue server's HTTP API" Settings copy remain.
- **`/queues` does not exist** on the Control API (use `/dashboard` and `/queues/summary`); the panel's queue list is
  built from those.

**Verify (all run here)**

| Command | Result |
| --- | --- |
| `bun run typecheck && bun run lint && bun run format:check && bun run architecture` | exit 0 (lint: the carried panel warnings) |
| `bun test packages/panel` | 1,175 pass, 0 fail |
| `QCLOUD_REQUIRE_DB=1 bun test packages/control-api test/contract` | 449 pass, 12 skip (Pub/Sub emulator), 0 fail |
| `bun run test:e2e` (`--project=chromium`) | 18 passed |
| WebKit project | 18 passed |
| Firefox project | **not run**: the browser did not launch in this sandbox |

**Not run / not verified**

- Firefox e2e; the new CI `e2e` job (Chromium) has never run in GitHub Actions.
- OIDC against a real identity provider; a deployed panel behind a real `/config.json`.
- Anything against a cloud (D9): no Cloud Run, no Pub/Sub, no Cloud SQL.

**Owed**

- Decide whether to hide Benchmark (a sixth `hidden` name such as `workerProtocol`) or serve `pull-batch`/`ack-batch`.
- A copy pass for the "Bunqueue v2.9.3" wording, the footer links and the `VITE_BUNQUEUE_*` names.
- Enable DLQ Purge for operators (the API supports it with `confirm`).
- The 120 React-compiler lint warnings.
