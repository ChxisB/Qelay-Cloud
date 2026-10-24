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
- **Disable what cannot be done safely.** A control the panel cannot make safe is not offered with a warning: it is disabled or
  left off the page. An action is safe only when the server can refuse it if the job changed since the page read it (a state or
  version precondition) and when it cannot duplicate a side effect of a job a worker is running. That is why cancel, discard,
  completed requeue and every transition of an active job are off in `shared/flowOperationPolicy.ts`. Enabling one
  means giving the API the precondition first. The gate is the one place that changes, so the single-job and bulk surfaces
  cannot disagree. The panel explains the reason only for active jobs; the other gated controls are silent about why.

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
Control, SQLite Database, S3 Backup, Fleet, and the agent-backed card on a queue's Settings tab) is left out of the navigation
and answers "Not available in this deployment" on a direct URL. Flows and Workflows follow `features.flows` and
`features.workflows`. A `viewer` is shown no control that changes anything; the server stays the authority and
answers 403 if one is forced. Until the answer arrives the panel assumes the closed side: those pages are hidden and
the caller is a viewer.

## Navigation

`src/components/layout/navConfig.ts` is the one source for the sidebar, the breadcrumb and the command palette: 14 items
in four groups under **Home**. **Work** (Queues, Jobs, Dead letter queue, Cron jobs), **Automation** (Event gateway, Flows),
**Monitor** (Metrics, Workers, Logs, Alerts, Health) and **System** (Settings, System). An item can stand for several pages
(`also`): Jobs for Add job, Bulk add and the job inspector, Event gateway for Connections, Events, Metrics and Issues,
Flows for job flows and workflow runs, Health for Deployment, Diagnostics, Job delivery and Usage, System for Server,
Database, Backups, MCP, Benchmark and Fleet. Each keeps its own
path, so no bookmark moved, and a tab bar under the page title (`SectionTabs`) links its siblings. A page the deployment
closes is left out of the item, and an item with one page left shows no tabs.

**Home** (`/`) is the one screen for every number and every problem: a **Needs attention** list, worst first, where each row
links to the page that fixes it, and one card per area (Queues, Jobs, Dead letter queue, Workers, Cron jobs, Event gateway,
Job delivery, Health, Alerts) above the throughput chart, the queue table and recent activity. It reads what the pages
already read (`/deployment` once, shared with the status strip, plus `/transport` and, when the gateway is open, the
gateway's routes and 24-hour stats); a call that fails shows "Unavailable" in its own card and never blanks the page.
`src/pages/control/home/` has the model, the list, the cards and the feeds.

The **Event gateway** (`src/pages/control/gateway/`, `/events-gateway`) is the webhook page with Hookdeck's screens as the
reference (Connections, Events, Metrics, Issues). It is described in [docs/event-gateway.md](../../docs/event-gateway.md).

## Look and feel

The console follows the "Qelay Console Redesign" Claude Design canvas (33 boards, the Carebell design system),
applied on 2026-10-20: <https://claude.ai/artifact/F5owf5M7tMgXzPyJts8S2k>. It changes how pages look, not what they do.
The board-to-page map and every place the panel departs from a board are in
`.claude/.planning/console-redesign/DESIGN-MAP.md`.

On 2026-10-22 the console gained motion and a connected look (nodes, lines and pills where things really are connected),
from the "Design" canvas (16 boards): <https://claude.ai/artifact/TMMbZ97jDRzvSpWiFVKRuG>. Again it changes how pages look
and move, not what they do. Its board-to-page map, every numbered deviation and the wording that still needs the owner's word
are in `.claude/.planning/motion-redesign/DESIGN-MAP.md`.

On 2026-10-23 the Event gateway gained inbound sources (D14): a Sources tab, a Requests tab, and a Source picker in place of
"Events to send" on a connection. No Claude Design canvas was made for it: the pages reuse the Destinations list, the Events
table and the connection form, with no new token, font or route outside the gateway. The plan is
`.claude/.planning/inbound-sources/CURRENT.md`, and the checks that ran on the pages are in
`.claude/completions/2026-10-23-inbound-sources.md`.

- **Colour lives in one file.** `src/tokens.css` holds the tokens (`--primary`, `--link`, `--ring`, `--state-*` and the
  rest), dark by default and overridden under `[data-theme='light']`; `src/index.css` imports it and maps the roles into
  Tailwind. Change a value there and every utility built on it follows. `test/design-tokens.test.ts` computes WCAG contrast for each text and surface pair, so a token that is too
  pale fails the test.
- **Type scale.** `--text-xs` (13px) and `--text-sm` (15px) in `src/index.css` sit one step above Tailwind's defaults; body
  text is 15px, titles are bold, and buttons and fields are 40px tall (DESIGN-MAP R25).
- **Plain wording, aligned forms.** A card says what it is, shows the current value and has one main action. Labels use
  everyday words and units go in the hint ("60000 is one minute"); request keys are unchanged. A label sits 8px above a
  40px control and `FormRow` aligns a row's controls on one top edge (`FieldAction` lines a button up with them).
  Rarely used controls sit in `Disclosure` (Advanced, Remove, Why?), and an action the server switches off is said once
  per page. Page titles are sentence case like the nav (DESIGN-MAP R26 to R33).
- **Cards that say first, graphs that show.** A settings card (`ReadFirstCard`) states what is set as a sentence and opens
  its fields behind **Edit**; the Cron and Webhooks create forms (`CreateCard`) open behind a button. Job flows draw as a
  read-only graph (Graph | List switch) and a run's definition as a chain with its place marked; empty pages teach with a
  small drawing (DESIGN-MAP R34 to R37). None of it edits a workflow: the graphs are for reading.
- **Shapes and focus.** Cards use `rounded-card`, fields `rounded-control`, buttons and badges are pills. Keyboard focus
  is one 3px `:focus-visible` outline in `--ring`; do not override it on a control.
- **Status is never colour alone.** A state pill is its word and a glyph whose shape differs per state.
- **Motion is one system.** Ten non-colour tokens in `src/tokens.css` (press 160 ms, hover 240 ms, enter 300 ms, exit 180 ms,
  stagger 40 ms capped at 8 items, draw 600 ms, flow 900 ms, and the `settle`, `exit` and `pop` easings) and the patterns in
  `src/motion.css` (`motion-arrive`, `-leave`, `-stagger`, `-flash`, `-draw`, `-fill`, `-comet`, `-pop` and the rest). Only
  `transform` and `opacity` move, and every `animation` and `transition` sits inside
  `@media (prefers-reduced-motion: no-preference)`, so reduced motion turns each into an instant change. A thing that leaves
  stays mounted for the exit time through `usePresence` (one overlay) or `useLeavers` (a list). No package: CSS, `@starting-style`
  and the router's `viewTransition`.
- **Motion says something true.** A wash, flash or pulse fires only when a polled value really changed since the last read;
  a first load arrives once in order and a poll that changes nothing animates nothing. Nothing loops and no traffic is faked
  (the panel only polls).
- **Connected language.** `src/components/ui/nodegraph/` holds the node, the line, the pill on the line, the rule glyphs and the
  hover card. They draw the Connections diagram, a connection and its event attempts, the Home Job flow, a queue's lifecycle,
  a cron's queue, a destination's connections and the Health delivery line, from counts and fields the pages already read.
  A control for something the server gates off (`shared/flowOperationPolicy.ts`) is never drawn.
- **The page asks, the browser does not.** Every confirmation goes through `confirmInPage()`
  (`src/components/dashboard/stores/confirmStore.ts`, shown by `components/ui/ConfirmDialog.tsx`, role `alertdialog`), which
  answers asynchronously. A test answers it with `answerConfirms()` from `test/confirmSupport.ts`.
- **Guards.** `accent-split-guard`, `ui-primitives-guard`, `state-colours`, `brand-assets` and `design-rules-guard` in
  `test/` fail when a page drifts from these rules. `motion-guard` fails on a raw time, a stray `@keyframes`, a motion rule
  outside no-preference, a property other than `transform` and `opacity` in a keyframe, or a presence hook that holds a node
  past the exit time. `native-dialog-guard` fails on `window.confirm`, `prompt` or `alert` (a bare call is caught only when its
  message is a literal).
- **Fonts are Plus Jakarta Sans and JetBrains Mono**, from `@fontsource-variable/plus-jakarta-sans` and
  `@fontsource-variable/jetbrains-mono`, served from the panel's own origin (the CSP is `font-src 'self'`, so the design's
  Google Fonts link is not used). `src/fonts.css` ships the latin and latin-ext subsets, upright only; `test/fonts.test.ts`
  guards the families, the files and that no font comes from another host.

## Browser tests

`bun run test:e2e` (from the repository root) builds the panel and starts `e2e/runtime.ts`: a migrated Postgres
schema (`QCLOUD_TEST_DATABASE_URL`, default `127.0.0.1:55432`), an in-process transport, the Control API twice (an
operator's token and a viewer's) and the built panel served under two mounts. Nothing in it reaches a cloud.

`e2e/control-api.e2e.ts` is the main flow: add a job, see it, pause and resume its queue, create a cron, a failed job
that is not offered a retry, the hidden pages, a viewer that cannot mutate, and a credential that stays out of storage.
`e2e/deployment.e2e.ts` runs the real in-process tick (`TickLoop`, every second) with small thresholds (late after
4 s, stale after 9 s) and stops it through the runtime's `POST /tick/stop`: the Dashboard's status strip goes amber, then
red, links to the Deployment page, and is green again after `POST /tick/start`.
The other specs are the upstream ones that still apply, run against this stack. Pull requests run them in Chromium; the
nightly workflow runs Firefox and WebKit. No Firefox spec has run yet: the build sandbox refuses to start it. The sign-in dialogs of
OIDC are covered by unit tests with a fake client, not by the browser specs.

## Not done yet

- A queue's Settings tab has a queue-operations card that calls the upstream agent's `/queue-operations/*` routes. A deployment lists
  `queueOperations` under `hidden` and the card is left out; with an agent address set it still works.
- Bare version numbers from the old wording (for example "v2.9.3") remain in some comments and two Add Job hints.
  They name no product, and no test depends on them being removed.
- The DLQ page retries failed jobs (one with its version, or up to 500 by reason) but has no purge button, though the
  Control API can purge with `confirm`. A failed job that belongs to a flow shows "In a flow" and is not retried.
- `VITE_QELAY_URL` and `VITE_QELAY_AGENT_URL` are build-time names. `config.json` is the way a deployment
  names the API.
- The footer and command palette link to the qelay-control-panel repository, not to a Qelay Cloud one.
- 120 React-compiler lint findings (`react/refs`, `react/set-state-in-effect` and three more) are warnings in the root
  `.oxlintrc.json` for this package only. The upstream lock used an Oxlint that did not have them.
