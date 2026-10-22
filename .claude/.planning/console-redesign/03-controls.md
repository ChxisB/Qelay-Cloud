# 03 — Controls, cards, page header

**Status:** done · **Depends on:** 02 · **Touches:** packages/panel/src/components/ui (Button, LinkButton, form, SearchField, Card, PageHeader, Pagination, Kbd), packages/panel/test

## Goal
Buttons, form controls, cards, the page header and pagination match the Components board.

## Steps
1. Button, IconButton, LinkButton (`buttonClass`): pill shape, 44px target (36px for `sm` in dense rows, with a 44px hit
   area), variants default (outline), primary (action fill), ghost, danger (outline). Keep the exported names and props.
2. `form.tsx`: Label, Field (label above, hint or error below), Input and Select (48px, 14px radius, `field-line` border,
   error state), Textarea if one exists, Toggle (the `.tgl` switch, `role="switch"`), SegmentedControl (`.seg`).
3. `SearchField`, `Kbd`, `Pagination` ("Showing X of Y", Previous and Next as small buttons).
4. `Card`, `CardHeader`, `SectionTitle`: card radius, title and sub line (`card-title`, `card-sub`).
5. `PageHeader`: title, lede, actions slot, as one component with the same props. The boards have no eyebrow above a
   title (checked by grep), so none is added. Existing callers keep working.
6. Update the tests that assert old class names or geometry, in this task.

## Acceptance
- No exported name or required prop of these components changed (`bun run typecheck` passes with no page edit).
- Controls are at least 44px tall at their default size (a test reads the class list).
- Every control shows the 3px focus ring from task 02 and a disabled state at 50 per cent (the design's `.btn[disabled]` and `.input[disabled]` value, plan said 40).
- `Toggle` is `role="switch"` with `aria-checked`, and the error `Field` sets `aria-invalid` and `aria-describedby`.
- A control that sets its own `aria-describedby` keeps it.

## Verify
```bash
bun test packages/panel/test && bun run typecheck && bun run lint && bun run format:check
```

## Risks / notes
- Task 02 made `--line-strong` the design's field line (3.37:1 on white), so `border-line-strong` is already the control
  border. Task 16 darkened light `--line-strong` to `#778898` (R22), so the edge is 3:1 or more on the grey ground as
  well. Inputs still use `bg-surface`, as the design does.
- Taller controls make dense tables and toolbars taller. Row-level actions use `sm` and are checked in tasks 08 to 13.
- The 16px floor for inputs on phones in `index.css` stays.

## Result
Done 2026-10-20. Files: `ui/Button.tsx`, `form.tsx`, `SearchField.tsx`, `Kbd.tsx`, `Pagination.tsx`, `Card.tsx`,
`PageHeader.tsx`, plus `index.css` (two tokens) and one-class swaps in `CopyButton.tsx` and `feedback.tsx` (see below).
No page file changed, no exported name or required prop changed (`bun run typecheck` clean).

**What changed**
- `Button`, `LinkButton`, `buttonClass`: bold pill, `min-h-11` at both sizes (`sm` only narrows padding and text to
  13px, as the design's `.btn-s` does), 1.5px `--line-strong` border, hover wash, primary hover is a 6 per cent
  brightness lift, danger is an outline with a `--danger-tint` hover, disabled is 50 per cent.
- `IconButton`: a 44px circle on `--surface` with the field-line border; new optional `size="sm"` gives 36px for dense
  rows. **Visible change:** the default variant is now the bordered one (was `ghost`), because 65 of the design's icon
  buttons are bordered; the 13 existing row-action callers get a bordered 44px circle until their page task passes `size="sm"`
  or `variant="ghost"`.
- `Input`, `Select`: 48px, 15px / 500, 1.5px field-line border, card colour, 14px radius, `aria-invalid:border-bad`.
  `Label` is now 13px bold sentence case (was 11px uppercase tracked), hints 12.5px.
- `Field`: new optional `error` prop. For a single Input/Select/textarea child it sets `aria-invalid="true"` and
  `aria-describedby` to the hint and error ids; it also now describes the control by its hint (new, was unlinked).
  A control's own `aria-describedby` wins. Compound children get the error text only, as before for ids.
- `Toggle`: the design's `.tgl`: 48x44 target, 46x26 track (`--line-strong` off, `--ok` on), 20px thumb that moves 20px.
  Still `role="switch"` with `aria-checked`, same props.
- `SegmentedControl`: the design's `.seg`: pill with a 1px field-line border, 44px-high segments, pressed segment on
  `--segment-active` in extra bold. Focus outline is inset (negative offset) because the pill clips overflow.
- `SearchField`: 44px, 1.5px border, card colour, 15px input. `Kbd`: 12px mono on `--slate-tint`, 8px radius.
- `Pagination`: Previous and Next are `buttonClass('default', 'sm')`; the current page is plain bold text, not a tinted
  chip. Same props, same summary strings, same self-correct effect.
- `Card`: 24px padding, `shadow-panel` (none in dark, the design's soft shadow in light). `CardHeader` title is 18px
  extra bold; `SectionTitle` the same. `PageHeader`: fluid 26 to 36px extra-bold title with the design's tight
  tracking, 15px lede capped at 680px, header row aligned to the baseline.
- Tokens: `--on-ok` (thumb on the on track) and `--panel-shadow`, registered as `--color-on-ok` and `--shadow-panel`.
- Every control above uses a 3px outline with a 3px offset. `CopyButton` and the offline banner's retry in `feedback.tsx`
  each had `outline-2`; I changed that one class in each because `ui-components-a11y.test.tsx` checks them together with
  the controls. Their other styling is left for their own tasks (05 and 08).

**Plan changes** (the plan files say so too): no `eyebrow` on `PageHeader` (the boards have none); fields are 48px, not
52 (the design's `min-height`); disabled is 50 per cent, not 40 (the design's value).

**Tests changed or added**
- `ui-primitives.test.tsx`: Button/IconButton/SearchField/Segmented/ErrorState-retry assertions now read the new
  geometry (pill, `min-h-11`, `size-11`/`size-9`, 3px outline, 50 per cent disabled). Reason: they encoded the old 36px
  and 10px look, not a rule.
- `ui-components-a11y.test.tsx`: the focus-outline check now reads `outline-3` (name said "violet", now "3px"). The
  rule it guards (every control carries a solid visible outline, none uses `outline-none` or a translucent ring) is unchanged.
- `ui-primitives-guard.test.ts`: `rounded-md` is no longer allowed in `Pagination.tsx` (it no longer uses it), so the
  guard is stricter; comment text updated to 28/14/pill.
- `design-tokens.test.ts`: `--on-ok` registered and at least 3:1 on `--ok` in both themes; `--shadow-panel` mapping and
  per-theme values.
- New `ui-form-controls.test.tsx` (the 300-line cap forced a split): `Toggle` (role, aria-checked, 48x44, track and thumb
  state, disabled), `Input`/`Select` (48px, border, invalid style), `Field` (no error, error plus hint ids, own
  `aria-describedby` kept). Mutation check: removing the `aria-invalid` line made exactly the error test fail; restored.

**Ran, against what**
- `bun test packages/panel`: 1389 pass, 0 fail (207 files, 56 s).
- `bun run typecheck` clean; `bun run format:check` clean; `bun run lint` exit 0 (the same react-hooks warnings in files this
  task did not touch); `bun run scripts/check-file-size.ts` ok (1550 files); `bun run --cwd packages/panel build` ok
  and the built CSS contains `outline-3`, `outline-offset-3`, `shadow-panel`.
- Screenshots (installed Chromium headless shell 1248, `vite preview`, demo mode, 1440x900, dark and light) of
  `/settings`, `/queues` and `/add-job`, read by eye against the board CSS, not pixel-diffed.

**Seen, for later tasks:** the JSON textarea and the "Bulk import" link button on Add Job are page-level styles and still
old (tasks 10 and 12). Row-action icon buttons make table rows about 65px tall (task 08 decides `size="sm"`). Queue
health and stat cards keep the old eyebrow (task 04). The topbar search trigger and sidebar are task 06.

**Not run:** `bun run architecture` beyond the file-size script, the root `bun test`, and Playwright e2e (task 16). The
on-state of `Toggle` was not seen in a screenshot (every switch on the sampled pages is off); it is covered by the unit
test only. 390px screenshots (task 06 first).
