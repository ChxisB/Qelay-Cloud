# 01 — D12 design sign-off

**Status:** todo · **Depends on:** none · **Touches:** DESIGN.md

## Goal
The owner signs off, or changes, the D12 model before any code exists.

## Steps
1. Present DESIGN.md section 6 "Inbound sources (D12)" to the owner with the open choices below.
2. Record the answers in DESIGN.md and flip D12 to Decided, or record what changed.
Open choices: ingest as its own package and process (recommended) or a route group on the Control API (not recommended: it is operator-scale and authenticated); body cap (256 KB); a rejected request stored with a cause (yes, capped); verification kinds for the first cut (none, HMAC, basic, API key); whether a Stripe preset ships in the first cut (no).

## Acceptance
- D12 reads Decided in the table and in section 6, with the owner's date.
- Every open choice has an answer recorded.

## Verify
```bash
grep -n 'D12' DESIGN.md
```

## Risks / notes
- Gate: owner sign-off. Nothing else in this plan starts before it.

## Result
