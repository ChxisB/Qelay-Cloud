# @qelay-cloud/panel

The React control panel for Qelay Cloud. It is a copy of
[qelay-control-panel](https://github.com/ChxisB/qelay-control-panel) (MIT) that now diverges from it (decision D8). It reads and drives the
Control API in [`packages/control-api`](../control-api).

- **Source:** `../qelay-control-panel` at commit `8ebf9328950a23a2f2687115a0ec15e66b7659bd`, the committed `HEAD`,
  extracted with `git archive` so the copy is reproducible. Provenance, what was left out and what was
  changed are in [docs/PORTING.md](../../docs/PORTING.md) ("Panel").
- **Licence:** [LICENSE](LICENSE) keeps the upstream notice and adds this repository's.

## Run it

```bash
bun install                                   # from the repository root
bun run --cwd packages/panel dev:stub         # fixture data, no API needed (demo mode)
bun run --cwd packages/panel dev              # proxies /api to the Control API on :8080
bun run --cwd packages/panel build
bun test packages/panel                       # from the repository root
bun run test:e2e                              # from the repository root: Playwright, needs Postgres
```

`dev` proxies `/api` to `http://localhost:8080`; set `VITE_PROXY_TARGET` for another origin. Opening any
page with `?demo` in the URL also serves the fixtures.

## What is here

| Path          | Contents                                                                                     |
| ------------- | -------------------------------------------------------------------------------------------- |
| `src/`        | The app: `lib/` (API clients, demo shim, assistant), `components/`, `pages/`, `features/`.   |
| `shared/`     | `flowOperationPolicy.ts`, which `src/` imports. It was shared with the upstream agent.       |
| `test/`       | `bun test` suites for `src/` and `shared/` (preloaded by `test/setup.ts` via `bunfig.toml`). |
| `e2e/`        | Playwright specs and `runtime.ts`, the stack they run against (see "Browser tests").         |
| `patches/`    | The `ai@7.0.14` patch. The root `package.json` lists it under `patchedDependencies`.         |

The upstream control agent (`agent/`), its scripts, its docs site, its Docker and release tooling were
not copied. The Control API replaces the agent.

## Rules carried over

- English only, in code, comments, tests and docs. Copy is sentence case.
- Files stay under 300 lines (`bun run architecture` at the root checks this).
- New API work goes through `src/lib/bq.ts` and `src/lib/bq/`. `src/lib/api.ts` is the first-generation client.
- Storage keys keep the `qelay-` prefix; `src/lib/legacyStorage.ts` adopts the older `bq-dash-*` keys once.
- The panel never imports from outside `packages/panel`.

## Connecting to a Control API

The panel talks to the Control API only. One build runs against any deployment: it reads
`config.json` beside `index.html` at start, before anything is drawn.

```json
{ "apiBaseUrl": "https://control.example.com", "auth": { "mode": "token" } }
```

```json
{
  "apiBaseUrl": "https://control.example.com",
  "auth": {
    "mode": "oidc",
    "authority": "https://login.example.com/realms/ops",
    "clientId": "qelay-panel",
    "scope": "openid profile",
    "audience": "https://control.example.com"
  }
}
```

- `apiBaseUrl` is an http(s) URL or a path such as `/api`. Left out, the panel keeps its default (`/api`, proxied in
  `dev`).
- `auth.mode` is `token` (the person pastes a bearer token; that is the Control API's development mode, and it is
  refused there in production) or `oidc` (authorization code with PKCE through `oidc-client-ts`; `authority` must be
  https, except on loopback). `audience` is optional and is sent as the `audience` authorization parameter.
- The file is public. Unknown keys are refused, and so is any key whose name looks like a secret (`secret`,
  `password`, `token`, `api key`, `private`, `credential`), so a mistake fails the start-up and not a review.
- A missing file (404, or a host that answers with the app's HTML) means the defaults. A file that is there and wrong
  stops the panel with the reason.

Tokens live in memory only. They are never written to `localStorage`, `sessionStorage`, a URL or the console
(`test/auth-no-leak.test.tsx` and the e2e spec check this). The OIDC library keeps its PKCE and state record in
`sessionStorage` for the length of a sign-in; that record holds no token.

`GET /capabilities` is fetched once per connection. A page that needs a Qelay TCP server or a local agent (Server
Control, SQLite Database, S3 Backup, Fleet, and the agent-backed card on Queue Control) is left out of the navigation
and answers "Not available in this deployment" on a direct URL. Flows and Workflows follow `features.flows` and
`features.workflows`. A `viewer` is shown no control that changes anything; the server stays the authority and
answers 403 if one is forced. Until the answer arrives the panel assumes the closed side: those pages are hidden and
the caller is a viewer.

## Browser tests

`bun run test:e2e` (from the repository root) builds the panel and starts `e2e/runtime.ts`: a migrated Postgres
schema (`QCLOUD_TEST_DATABASE_URL`, default `127.0.0.1:55432`), an in-process transport, the Control API twice (an
operator's token and a viewer's) and the built panel served under two mounts. Nothing in it reaches a cloud.

`e2e/control-api.e2e.ts` is the main flow: add a job, see it, pause and resume its queue, create a cron, a failed job
that is not offered a retry, the hidden pages, a viewer that cannot mutate, and a credential that stays out of storage.
`e2e/deployment.e2e.ts` runs the real in-process tick (`TickLoop`, every second) with small thresholds (late after
4 s, stale after 9 s) and stops it through the runtime's `POST /tick/stop`: the Dashboard's status strip goes amber, then
red, links to the Deployment page, and is green again after `POST /tick/start`.
The other specs are the upstream ones that still apply, run against this stack. They run in Chromium and WebKit
here; the Firefox project is configured but was not run in the sandbox this was built in. The sign-in dialogs of
OIDC are covered by unit tests with a fake client, not by the browser specs.

## Not done yet

- Queue Control's queue-operations card calls the upstream agent's `/queue-operations/*` routes. A deployment lists
  `queueOperations` under `hidden` and the card is left out; with an agent address set it still works.
- Bare version numbers from the old wording (for example "v2.9.3") remain in some comments and two Add Job hints.
  They name no product, and no test depends on them being removed.
- The DLQ page's Retry and Purge buttons stay disabled by the upstream flow-safety copy, though the Control API
  can purge with `confirm`.
- `VITE_QELAY_URL` and `VITE_QELAY_AGENT_URL` are build-time names. `config.json` is the way a deployment
  names the API.
- The footer and command palette link to the qelay-control-panel repository, not to a Qelay Cloud one.
- 120 React-compiler lint findings (`react/refs`, `react/set-state-in-effect` and three more) are warnings in the root
  `.oxlintrc.json` for this package only. The upstream lock used an Oxlint that did not have them.
