# Console redesign: the Carebell look for `packages/panel`

Apply the "Qelay Console Redesign" design (a Claude Design canvas, 33 boards, Carebell design system) to the control
panel in [packages/panel](../../../packages/panel). The design is a visual change. Every board maps to a page that already
exists, and the navigation is identical.

- **Design source:** https://claude.ai/artifact/F5owf5M7tMgXzPyJts8S2k (read with the Artifact tool, `action: read`). A
  local copy of its files is in the session scratchpad only. The board-to-page map and every deviation are in
  [DESIGN-MAP.md](DESIGN-MAP.md), which is the file to read first.
- **Baseline:** branch `feat/review-2026-10-19`, clean tree, panel as of commit `eea4137`.
- **Started:** 2026-10-20.

## Goal

Every operator-facing panel page, the shell, the overlays and the auth and error states look like the design in dark
and light, with no change to what the panel does, what it calls, or what it refuses to do.

## Scope

**In**

- The token layer (`src/tokens.css`, imported by `src/index.css`): Carebell colours, shape, focus ring, type stack. Role names stay (`--primary`,
  `--link`, `--ring`, `--state-*`), only values change, so the 160+ Tailwind utilities that use them re-skin without edits.
- Shared primitives in `src/components/ui`: buttons, form controls, cards, page header, pagination, status glyph and
  pill, transport tag, key-figure tile, banners, toasts, empty, loading and error states.
- The shell in `src/components/layout`: sidebar, brand lockup, profile switcher, health card, user block, top bar,
  breadcrumbs, mobile drawer.
- Overlays: command palette, Copilot panel, confirm card, drawers, modals, row menus.
- Data display: table row recipe, charts, log viewer.
- The 30 page boards, grouped into five page tasks, plus Auth and Page states.
- Tests: updated deliberately where they encode the old look or copy, never loosened.

**Out**

- Behaviour, routes, the Control API client, `shared/flowOperationPolicy.ts`, capability gating, auth and roles. The
  shell may *show* the role and subject that the stores already hold. It does not change how they are decided.
- The `*-classic` pages (`/jobs-classic` and the rest). They have no board. They pick up the token layer and the shared
  primitives and nothing more.
- New routes, new endpoints, new migrations, `docs/openapi.yaml`, anything under `infra/`.
- Design elements that need data the panel does not have. Each one is listed in DESIGN-MAP.md and is left out, not faked.
- `../qelay` and `../qelay-control-panel`.

## Touches

- `packages/panel/src` (index.css, components, pages) and `packages/panel/test`, `packages/panel/e2e`.
- `docs/PORTING.md` (one row under "Panel, Changed") and the panel README's design note.
- A new dependency pair for fonts, **only after the user's go-ahead** (task 01).
- No migration, no openapi change, no infra, no store or transport interface.

## Design impact

Fits DESIGN.md. The panel is a copy that diverges by decision D8 and this is a visual divergence only. The old
product-UI palette was itself a redesign of the upstream one, which the guards in `test/` record. This change replaces
that palette with the design's, so three guards are updated in task 15.

## Approach

Re-skin through the token layer and the shared primitives first, then each page group. A page task touches the page's
own markup only where the board's layout differs from the primitives' output. A page keeps its tests passing, and a test
that asserts old copy is edited in the same task to assert the board's copy.

## Risks

1. **Fonts needed a new dependency or vendored woff2** (CSP is `font-src 'self'`, so the design's Google Fonts link cannot
   be used). The owner approved the two `@fontsource-variable` packages on 2026-10-20 and task 01 is done.
2. **Contrast.** The e2e axe checks run on every route. Task 02 adds a unit test that computes WCAG contrast for each
   text and surface pair in `index.css`, so a bad token fails fast.
3. **Copy ripple.** Sentence-case nav labels appear in 20 test files and 8 e2e files (37 source hits). They change in one
   task (06) with their tests.
4. **Size.** 123 page files. Page tasks stay under a handful of files each by splitting again when needed. Files stay
   under 300 lines.
5. **No visual diff harness.** The design boards need a `support.js` that is not in the export, so they cannot be
   rendered here. Visual checks are screenshots of the panel read by eye against the board's CSS values, and are said to
   be that in each Result.
6. **E2E needs Postgres and a browser.** Docker is deferred by the user's standing instruction, so e2e runs against the
   Docker-free local Postgres if it is up, and is otherwise reported as not run.

## Human gates in this plan

| Gate | Task | State |
|------|------|-------|
| New dependency (`@fontsource-variable/plus-jakarta-sans`, `@fontsource-variable/jetbrains-mono`, drop `inter`) | 01 | approved by the owner on 2026-10-20, done |
| Anything about auth or roles | 06 | not hit: display only, recorded in DESIGN-MAP.md R5 |
| Push, publish, version bump | none | never in this plan |

## Status

| # | Mini-task | Depends on | Status |
|---|-----------|-----------|--------|
| 00 | [Design intake and map](00-design-intake.md) | none | done |
| 01 | [Fonts](01-fonts.md) | 00 | done |
| 02 | [Tokens](02-tokens.md) | 00 | done |
| 03 | [Controls, cards, page header](03-controls.md) | 02 | done |
| 04 | [Status glyph, pills, tags, key figures](04-status.md) | 02 | done |
| 05 | [Feedback: banners, toasts, empty, loading, error](05-feedback.md) | 03, 04 | done |
| 06 | [Shell](06-shell.md) | 03, 04 | done |
| 07 | [Overlays](07-overlays.md) | 03, 05 | done |
| 08 | [Tables, charts, log viewer](08-data-display.md) | 04 | done |
| 09 | [Pages: Overview, Fleet, Queues](09-pages-overview-queues.md) | 06, 08 | done |
| 10 | [Pages: Jobs, DLQ, Cron, Workflows, Flows](10-pages-jobs-workflow.md) | 06, 07, 08 | done |
| 11 | [Pages: Monitoring group](11-pages-monitoring.md) | 06, 08 | done |
| 12 | [Pages: Control group](12-pages-control.md) | 06, 07 | done |
| 13 | [Pages: Management group](13-pages-management.md) | 06 | done |
| 14 | [Auth and page states](14-auth-and-states.md) | 05, 06 | done |
| 15 | [Guards, docs and PORTING row](15-guards-docs.md) | 09 to 14 | done |
| 16 | [Verify and review](16-verify.md) | all | done |

Order of work: 02, 03, 04, 05, 06, 07, 08, 09 to 14, 15, 16. Task 01 waited for the owner's approval and was done last.
