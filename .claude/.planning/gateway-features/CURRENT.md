# Gateway features (G1 to G5)

Approved by the owner on 2026-10-21: "I'm happy for you to implement the new features and ui changes. No need to ask me :)".
Follows [gateway-ui](../gateway-ui/CURRENT.md), which stopped at five proposals. Decision: D13 in [DESIGN.md](../../../DESIGN.md).

## Goal
The Event gateway has what Hookdeck's console has and the panel could not do yet: a name and editable rules, delay and
dedupe, a pause that holds beside one that ignores, issues you can acknowledge or resolve, saved destinations, and a list
that shows each connection's last 24 hours from one read.

## Scope
- **In:** G1 grouped stats, G2 issue state, G3 name, description and editing, G4 delay, dedupe and Disable-and-ignore (the
  transform is the existing `shape`), G5 reusable destinations. Migrations 17 to 19, new routes with audit, the panel, docs.
- **Out:** inbound HTTP sources (D12, its own plan and security review); user-code transforms; reusable *sources* (a source is a
  queue until D12); editing a route's source queue or destination (remove and add); replay of a request; delivery groups.
- **Still the owner's:** commit, push, publish, version bump; any real cloud write; new dependencies (none are added).

## Touches
`packages/core`, `packages/store-postgres` (migrations 17, 18, 19), `packages/control-api` (routes, openapi, audit),
`packages/panel`, docs. Not `infra/`, not the transports, not core queue semantics (so no `test:model`).

## Design impact
Fits D11 and adds D13. Nothing a previous release reads or writes is removed or retyped. The one behaviour that changes for a
user is that the panel's Pause now holds events (the API default stays ignore).

## Risks
- The recording path (`webhookRecord.ts`) gains a statement per batch for issues: a hot path.
- Dedupe adds a write per writer page; keys are pruned by the tick.
- `webhooks.ts` is at the 300-line cap: update and validate move to their own files.
- Old workers cannot apply delay or dedupe: a route with either must be added after every tick runs the new release (the
  same note as the queue destination).

## Status
| # | Mini-task | Depends on | Status |
|---|-----------|-----------|--------|
| 01 | [design decision](01-design-decision.md) | — | done |
| 02 | [core rules](02-core-rules.md) | 01 | done |
| 03 | [migration 17](03-migration-17.md) | 02 | done |
| 04 | [writer rules](04-writer-rules.md) | 03 | done |
| 05 | [store update](05-store-update.md) | 04 | done |
| 06 | [api patch pause](06-api-patch-pause.md) | 05 | done |
| 07 | [migration 18 issues](07-migration-18-issues.md) | 06 | done |
| 08 | [api issues](08-api-issues.md) | 07 | done |
| 09 | [grouped stats](09-grouped-stats.md) | 06 | done |
| 10 | [migration 19 destinations](10-migration-19-destinations.md) | 08 | done |
| 11 | [api destinations](11-api-destinations.md) | 10 | done |
| 12 | [panel client](12-panel-client.md) | 11 | done |
| 13 | [panel connections](13-panel-connections.md) | 12 | done |
| 14 | [panel settings](14-panel-settings.md) | 12 | done |
| 15 | [panel issues](15-panel-issues.md) | 12 | done |
| 16 | [panel destinations](16-panel-destinations.md) | 12 | done |
| 17 | [docs gate handoff](17-docs-gate-handoff.md) | 16 | done |
