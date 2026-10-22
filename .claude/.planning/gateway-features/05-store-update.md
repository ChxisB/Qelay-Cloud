# 05 — Store update

**Status:** done · **Depends on:** 04 · **Touches:** packages/store-postgres

## Goal
`update(id, patch)` for name, description, events, filter, shape, delay and dedupe, and `setEnabled(id, enabled, mode)` with hold and ignore.

## Steps
1. `webhookUpdate.ts`: one transaction under the namespace advisory lock; the writer check for rules; null clears.
2. `setEnabled` takes `mode`: `hold` keeps deliveries being made and sets the reason `WEBHOOK_HOLD_REASON`.
3. `validate` moves to `webhookValidate.ts` (webhooks.ts is at the 300-line cap).

## Acceptance
- A patch changes only the fields it names; an empty patch is refused.
- A filter, shape, delay or dedupe on a namespace without the writer is refused.
- Hold keeps making deliveries and Resume sends them; ignore makes none (as before).
- A held route is not an auto-pause: its streak and alert level are unchanged by the hold.
- Null for an unknown id.

## Verify
```bash
QCLOUD_REQUIRE_DB=1 bun test packages/store-postgres/test/webhook
```

## Risks / notes


## Result
webhookUpdate.ts: update(id, patch) for name, description, events, filter, shape, delayMs, dedupe in one transaction (row FOR NO KEY UPDATE; writer check FOR KEY SHARE only when a writer-only rule is being set); empty or invalid patch refused by option name; null for unknown id. setEnabled(id, enabled, mode): hold keeps the failure reason or sets WEBHOOK_HOLD_REASON, touches no streak; ignore unchanged. core: WEBHOOK_PAUSE_MODES, webhookPausedBy. webhookStatsTypes.ts split out of webhookTypes.ts (300-line cap). Tests: webhook.update.test.ts (8), webhook.hold.test.ts (6), core +1. Local PG 18: core + store webhook*/schema* 458 pass; typecheck, oxfmt, oxlint, architecture clean.
