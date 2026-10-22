# V1 — Read-first card

**Status:** done · **Depends on:** none · **Touches:** packages/panel/src/components/ui, packages/panel/test

## Goal
One card primitive that shows a sentence with its values in bold, and an Edit button that reveals the fields.

## Steps
1. `components/ui/ReadFirstCard.tsx`: props `title`, `sub`, `summary` (ReactNode), `editLabel`, `children` (the form),
   `open` and `onOpenChange` (optional, so a card can close itself after a save). Built on `Card` and `CardHeader`.
2. The button has `aria-expanded` and `aria-controls`; the form shows a Cancel button; focus moves to the first field on open
   and back to Edit on close.
3. `Value` helper for the bold value inside a sentence (`font-bold text-fg`, no colour of its own).
4. Test: summary shows first, fields are not in the DOM until Edit, Cancel closes, keyboard works.

## Acceptance
- The fields are absent from the DOM until Edit is pressed (so `fill` on a closed card fails, by design).
- One main action per card: Edit when closed, the form's own primary button when open.
- No hex colour, no `text-xs`; passes `ui-primitives-guard` and `design-rules-guard`.

## Verify
```bash
LC_ALL=en_US.UTF-8 bun test packages/panel/test/read-first-card.test.tsx packages/panel/test/ui-primitives-guard.test.ts
bun run typecheck
```

## Risks / notes
A closed card must still say, in words, what is set. The card never shows an empty box.

## Result

- `components/ui/ReadFirstCard.tsx` (card, summary sentence with `Value`, Edit and Cancel button, optional `facts`) and
  `components/ui/useRevealFocus.ts` (focus into the first control on open, back to the button on close, nothing on first render).
  `Button` props are now `ComponentProps<'button'>` so it takes a `ref`.
- Ran: `read-first-card.test.tsx`, `ui-primitives-guard`, `design-rules-guard`, typecheck. All pass.
- Not run: a pixel diff against the boards.
