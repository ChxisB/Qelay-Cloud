# 01 — Record D12 Decided and D14 in DESIGN.md

**Status:** done · **Depends on:** none · **Touches:** DESIGN.md
**Design:** none

## Goal
The decisions the owner approved on 2026-10-23 are in DESIGN.md before any code follows them.

## Steps
1. Decision table: D12 becomes Decided (2026-10-23, approved as written); add D14 (inbound requests are the gateway's only source).
2. Section 6: D12 text revised to the approved form (separate `packages/ingest` on `Bun.serve`, 256 KB body cap, rejected requests
   stored with a cause and capped per source per minute, verification none/HMAC/basic/API key, no Stripe preset, no shape means the
   body and content type unchanged). Add D14 with the event document, the pipeline order, atomic dedupe, header redaction, no loops,
   and the fate of routes from before D14.
3. Where D11 and D13 name job events, the writer, the loop check or `route_cycle`, say they are superseded by D14 and point to it.

## Acceptance
- The decision table, D12 and D14 agree with `CURRENT.md` (read both side by side).
- No sentence in section 6 still says the gateway reads the job journal as a source, except as history under "superseded".
- `bun run docs:check` passes.

## Verify
```bash
bun run docs:check
```

## Risks / notes
- Documentation only. The code that makes D14 true is tasks 02 to 06.

## Result
Done 2026-10-23. `DESIGN.md`: D12 is Decided, D14 is new (decision table and a section after D12), D11 and D13 carry a
"superseded by D14" note and keep their text as history. `bun run docs:check` passed with the scratch Postgres up (7 documented
blocks run). Nothing else ran; no code changed.
