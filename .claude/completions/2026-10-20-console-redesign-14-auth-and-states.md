# Console redesign 14: sign-in, config error, auth gate, error pages

Date: 2026-10-20 · Plan: `.claude/.planning/console-redesign/14-auth-and-states.md`

## Changed (all under `packages/panel/`)
- `src/components/ui/feedback.tsx`: `EmptyState` gains `code` and `headingLevel`, `ErrorState` gains `headingLevel`.
- `src/pages/NotFound.tsx`, `src/pages/NotAvailable.tsx`, `src/components/RouteGate.tsx`, `src/components/ErrorBoundary.tsx`: on the shared Empty, Error and Loading states.
- `src/components/AuthScreens.tsx`: `SignInScreen` (redirecting, signed out, error) and `ConfigErrorScreen` on `Banner` and `Button`.
- `src/components/AuthGate.tsx`: visible label, `aria-describedby`, board button styling; logic and focus untouched.
- New `test/page-states-14.test.tsx` (8 tests); `test/frontend-a11y-fixes.test.ts` and `test/route-gate.test.tsx` updated; 404 locators in `e2e/dashboard.e2e.ts` and `e2e/all-routes.e2e.ts`.

## Checked
- `bun test packages/panel` (repo root): 1512 pass, 0 fail.
- `typecheck`, `lint`, `format:check`, file size, `architecture`: clean.
- `git diff -- packages/panel/src/lib/auth packages/panel/shared`: empty.
- Panel build; screenshots of 404, config error, sign-in error, "Signing you in" and the token gate in both themes at 1440 and 390: no horizontal scroll, no page errors, inspected.

## Owed or not run
- Playwright e2e and axe (local Postgres on 55442 was down): Phase 4. The 404 and Logs e2e edits are unexercised.
- No screenshot diff against the boards.
- Not built (board only, not in the real flow): see the task Result (IdP copy, Cancel, "Copy details", "not configured" card, direct-credential link, role pill, View session, NotAvailable board copy).
- Acceptance deviation: focus stays on the token input when the gate opens, not on a heading, because the existing tests pin it.
- Behaviour notes: the 404 `h1` is the title; the boundary's "Reload" is "Retry"; a failed route chunk reads "This page could not be opened"; the token gate has a visible label.
