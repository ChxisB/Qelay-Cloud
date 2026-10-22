# 07 — Connection page and the create page

**Status:** done · **Depends on:** 06 · **Touches:** packages/panel/src/pages/control/gateway (CreateConnection, ConnectionPage, ConnectionOverview, ConnectionSettings, ConnectionForm), test, e2e
**Design:** https://claude.ai/artifact/TMMbZ97jDRzvSpWiFVKRuG, board "Connection page"

## Goal
Draw one connection as a large live diagram with its overview, metrics and settings tabs, and let the create page build the same diagram as the form fills.

## Steps
1. Read the board, `DESIGN-MAP.md` (the deviations for this board) and the files above with their tests.
2. `ConnectionPage`: the header diagram (source, rules, destination) from the task 03 parts at a larger size; the tabs keep
   their routes and slide an underline with the shared highlight; the tab body arrives with `motion-arrive`.
3. `ConnectionOverview`: figures flash on a polled change only; the "Sent so far" label and other panel wording stay.
4. `ConnectionSettings`: rule switches use `Toggle` (word always shown). Replace both `window.confirm` calls
   (the destructive question at line 91 and the one in the render at line 189) with `confirmInPage`, with the same text.
5. `CreateConnection`/`ConnectionForm`: the diagram builds as fields are chosen: a node appears when its field has a value, the
   line draws when both ends exist. It never submits or fetches anything new, and Save is as today.
6. Edit the tests and e2e that stub the dialogs or pin the old markup in the same change.

## Acceptance
- Overview, metrics and settings keep their routes, data and controls. No new control, route or API call.
- Both confirms ask in the page and call the same API on true, nothing on false.
- The create page draws the diagram from the form state only and lists a missing end as a dashed placeholder with words.
- Focus order through the form is unchanged; switches expose their state to assistive tech.
- Reduced motion shows the finished diagram at once.

## Verify
```bash
bun test packages/panel/test/gateway packages/panel/test/motion-guard.test.ts && bun run typecheck && bun run lint && bun run format:check && bun run --cwd packages/panel build
```

## Risks / notes
- Controlled inputs must keep focus while the diagram re-renders; test typing a long value in the name field.
- The create diagram must not remount the form fields.

## Result
Done 2026-10-22. The connection page draws its line, and the new-connection page draws the typed one.

**G1 (no view or control lost): passed, nothing stopped.** Overview, Metrics and Settings keep their routes, data and
controls. No new control, route or API call. Nothing was added that `flowOperationPolicy.ts` gates off.

**New files** (`packages/panel/src/pages/control/gateway`): `ConnectionChain.tsx` (source, a glyph and a word per rule that is
on, destination, and the "Always on" footer; no control in it) and `ConnectionPreview.tsx` (the create page's side panel).
**Changed:** `ConnectionOverview.tsx` (the line on top; "Sent so far" figures wash on a poll), `ConnectionPage.tsx` (tab body
arrives with `motion-arrive`), `ConnectionSettings.tsx` (both questions asked in the page), `ConnectionForm.tsx` (the preview
beside the steps; DOM and tab order unchanged), `ConnectionFigures.tsx` (`Figure` exported), `ui/LinkTabs.tsx` (one underline
slides to the open tab), `ui/nodegraph/ConnectionNode.tsx` (`placeholder`: dashed outline for an end not chosen yet),
`motion.css` (`.tab-ind`, inside the reduced-motion query; the fallback `display: none` is outside it).

**Motion.** The tab body arrives (300 ms) and the tab underline slides. A comet runs once down the line only when a poll finds
a higher successful count, never on first load, an equal read or a fall. A figure washes only when a poll moves it. Reduced
motion: the finished line is in the page at once.

**Questions.** `window.confirm` is gone from `ConnectionSettings.tsx` (2 of 24 in 07, so 22 remain by the plan's count; a grep of
`src` shows 23 call lines, task 14's guard will settle the count). Rotate asks "Rotate the signing secret?" (or "Create a
signing secret?" when unsigned) with the 24-hour sentence as its detail; Remove asks "Remove the connection to <name>?" and is
a danger question. Escape, the scrim and Cancel send nothing; the main button sends the same call as before.

**Create page.** The preview is drawn from the form state only and makes no call of its own. A missing end is a dashed
placeholder with words ("Enter the address to send to", "Choose the source queue", "Choose the queue to add jobs to",
"Choose a destination"), and the line is dotted until both ends exist. A rule joins the line once its box holds text, valid or
not (the form still says whether it is valid). Typing keeps the same input node and its focus.

**Tests.** Edited, not loosened: `gateway-connection-settings.test.tsx` (the rotate, create-secret and remove tests ask in the
page: false sends nothing, true sends the same call; the dialog is mounted after the page so the page's buttons come first
while it leaves). `gateway.helpers.tsx` `route()` now carries `delayMs: null` and `dedupe: null` as the API does (without them
the rules read as "on"). New: `gateway-connection-chain.test.tsx` (8), `gateway-create-preview.test.tsx` (6).

**Ran** (this machine, no Docker, no Postgres): `bun test packages/panel/test/gateway packages/panel/test/motion-guard.test.ts`
254 pass, 0 fail; `bun test packages/panel` 1930 pass, 0 fail, 262 files (108 s); `bun run typecheck` 0; `bun run lint` exit 0
(existing warnings only; none in the new files); `bun run format:check` clean; `bun run --cwd packages/panel build` ok.
**e2e:** no spec drives the connection settings' questions, so none was edited. The specs that stub the browser dialog
(`walkthrough.e2e.ts:129`, `monitoring.e2e.ts:85`, `dashboard.e2e.ts:187`) belong to the cron and monitor tasks.
**Not run:** the full repo gate (`architecture`, the other packages), Postgres-backed tests, e2e (needs the stack and a
browser), `dev:stub` by eye at 1280 px and 390 px, the accessibility scan. Task 15 does these. Nothing was rendered, so look
and timing are unseen.

**Deviations from the plan and board (the owner is told in the hand-off; recorded in DESIGN-MAP):**
- No rule switches. Step 4 said "rule switches use `Toggle`", but the settings page has no rule switches (rules are text boxes
  and the fixed ones are read-only), and no new control may be added. Rules are shown as glyph plus the word "On".
- One wire with the rules drawn on it, not a wire per rule (one line, one meaning; the rules sit in the order an event meets them).
- Rotate and Create secret split the old single confirm text into a question and a detail line.
- On narrow windows and in the create page's side panel the line is vertical under a spine.

**Known risks, unverified:** the Tailwind classes in `ConnectionChain` (`top-15`, `bottom-15`, `left-[29px]`,
`max-lg:[&>span]:hidden`) and the spine alignment (assumes a 60 px node) have not been seen in a browser; the tab underline
slide assumes the tab routes keep one `ConnectionPage` instance; if only one end of the preview is missing the other end
takes the dotted outline; `confirmInPage` is async where `window.confirm` was sync; after a successful Remove focus goes to the page.
