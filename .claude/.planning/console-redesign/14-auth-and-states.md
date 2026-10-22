# 14 — Sign-in, config error, auth gate, error pages

**Status:** done · **Depends on:** 05, 06 · **Touches:** packages/panel/src/components/auth (SignInScreen, ConfigErrorScreen, AuthGate), packages/panel/src/pages (NotFound, route error), packages/panel/test, packages/panel/e2e

## Goal
The screens shown before or outside the console match the Auth and States boards.

## Steps
1. Read the Auth and States boards in full and the sources.
2. Sign-in: brand lockup with the tile, one provider button, the "no tokens in the browser URL" line only if it is true of
   the current flow. Config error: the problem and what to check. Auth gate: the blocking state with focus on its heading.
3. Not found and route error pages with the shared Empty and Error states.
4. No change to the OIDC flow, the session store, redirect handling or token storage.
5. Update tests and e2e that assert old markup.

## Acceptance
- `src/auth/**` and `authStore` are unchanged (`git diff --stat` shows neither).
- A screen reader hears the heading first when a gate opens (existing `auth:gate-opened` behaviour tests pass).
- Copy on these screens is true of the panel's real flow (R11).

## Verify
```bash
bun test packages/panel && bun run typecheck && bun run lint && bun run format:check && git diff --stat -- packages/panel/src/auth
```

## Risks / notes
- This touches the look of auth screens, not auth. If a step needs an auth change, stop: it is a human gate.

## Result

**Changed** (all under `packages/panel/`)
- `src/components/ui/feedback.tsx`: `EmptyState` takes `code` (a large decorative `aria-hidden` numeral) and `headingLevel`; `ErrorState` takes `headingLevel`. A page-level state renders an `h1`, an in-page one stays a `div`.
- `src/pages/NotFound.tsx`, `src/pages/NotAvailable.tsx` (`NotAvailable`, `OperatorOnly`): on `EmptyState`, one `h1`, a LinkButton back to a real route.
- `src/components/RouteGate.tsx` (loading is `LoadingState`, a failed chunk is `ErrorState` with Retry), `src/components/ErrorBoundary.tsx` (fallback is `ErrorState` in a `div`: the boundary is mounted twice in `AppLayout`, so it cannot be a `main`).
- `src/components/AuthScreens.tsx` (90 lines): `Frame` (QelayLogo and an `h1`), `SignInScreen` (redirecting, signed out, error) and `ConfigErrorScreen`, on `Banner` and `Button`.
- `src/components/AuthGate.tsx`: the token dialog has a visible label, `aria-describedby` on its reason, and the board's button styling. Logic, focus handling and the focus trap are untouched.
- Tests: new `test/page-states-14.test.tsx` (8 tests); `test/frontend-a11y-fixes.test.ts` and `test/route-gate.test.tsx` updated for the new markup. `e2e/dashboard.e2e.ts` and `e2e/all-routes.e2e.ts` 404 locators point at "That page does not exist".

**Ran**
- `bun test packages/panel`: 1512 pass, 0 fail (220 files). typecheck, lint, `format:check`, `architecture`: exit 0. File-size check OK.
- `git diff -- packages/panel/src/lib/auth packages/panel/shared`: empty. (The task file says `src/auth/**`; the real path is `src/lib/auth/**`.)
- Built the panel and served it with `vite preview`. Screenshots of 404, config error, sign-in error, "Signing you in" and the token gate, in light and dark at 1440 and 390 wide: no horizontal scroll, no page errors. I looked at them.

**Not run**
- Playwright e2e and axe: local Postgres on 55442 was down. The 404 locator edits here and the Logs ones from task 11 are not exercised by a run.
- No pixel diff against the boards.
- The "Signing you in" screen is not reachable at boot: `startOidcSession` awaits `signinRedirect` before the first render, so a held redirect shows a blank page. It shows only when the app is already mounted and sign-in restarts. I captured it that way (fail the first discovery, click "Sign in again", hold the retry). That is existing behaviour, not changed here.

**Not built** (the board shows it; the panel's real flow does not have it, R11)
- Sign-in "Continue with your identity provider" copy, the Cancel button on "Signing you in", the "Copy details for your administrator" button and block, the "not configured" IdP card, the "Use a direct credential instead" link.
- OperatorOnly "Your role: Viewer" pill and "View session" link; the NotAvailable board's Postgres and cloud-queue copy (the real `name` copy stays).

**Acceptance deviation**
- "Heading gets focus when a gate opens" is not done: the existing unit and e2e tests pin focus on the token input, and this task may not change that. The dialog is named "Authentication required" (`aria-label`) and is now also described by its reason.
- The signed-out copy was checked against `session.ts`: the access token is held in memory only, and the screen says so.

**Changed behaviour** (for the hand-off)
- The 404 `h1` is now the title; "404" is a decorative numeral.
- The error-boundary button "Reload" is now "Retry" (it still reloads the page).
- A failed route chunk is now an `ErrorState` headed "This page could not be opened".
- The token gate has a visible "Bearer token" label.

**Kept:** OIDC flow, `authStore`, session and token storage, redirect handling, `shared/`, routes, capability gating.
