---
name: revenue-leakage-auditor
version: 0.1.0
description: Turn a bounded invoice/ledger excerpt into a revenue-leakage audit packet. Reads ledger_lines[], known_subscriptions[], and optional baseline_window, computes expected_vs_actual per subscription, and emits a typed audit packet with leak_candidates[], confidence, refund_recommendation, and stop conditions. Never issues refunds, never modifies billing systems.
source:
  type: cli-tool
  command: node
  args:
    - run.mjs
links:
  source: https://github.com/runxhq/runx/tree/main/skills/revenue-leakage-auditor
runx:
  category: ops
  input_resolution:
    required:
      - ledger_lines
      - known_subscriptions
---

## What this skill does

Audit a bounded ledger excerpt against a known-subscription baseline and
emit a `runx.revenue.audit.v1` packet with leak candidates, per-line
expected-vs-actual diff, refund recommendation (if any), confidence, and
stop conditions. The runner is deterministic; it never issues refunds,
modifies billing systems, opens disputes, or contacts payment providers.

The skill proposes; a separate governed outbound skill can review, approve,
and emit authority grants before any external side effect runs.

## When to use this skill

Use this skill when an agent has a bounded ledger excerpt and a known
subscription set and needs a calm first-pass leakage audit. It is useful
in finance rotations, recurring-revenue reviews, and audit-sim workflows
where the same bounded inputs need a bounded output every time.

It is intentionally read-only by design. It emits audit packets; it never
enforces them.

## When not to use this skill

Do not use this skill to issue refunds, modify billing systems, dispute
charges, contact payment providers, or alter financial records. Do not
use it to override a finance team's manual audit or apply accounting
changes.

If `ledger_lines[]` is empty or `known_subscriptions[]` is empty, the
skill refuses with `needs_input`. If the inputs carry private customer
data that has not been summarized, the skill refuses with `refused`.

## Procedure

1. Require `ledger_lines[]` to be a non-empty array of bounded records
   with `{date, amount_usd, line_ref, vendor_hint?}`.
2. Require `known_subscriptions[]` to be a non-empty array of
   `{name, expected_amount_usd, cadence_days, last_seen_at?}`.
3. Accept optional `baseline_window_days` (default 35) and `tolerance_pct`
   (default 0.15).
4. For each subscription, find ledger lines within the baseline window
   whose `vendor_hint` matches `name` (case-insensitive token overlap) or
   whose amount matches `expected_amount_usd` within `tolerance_pct`.
5. Compute `expected_charges` for the window from cadence, and
   `actual_charges` from matched lines.
6. Emit leak candidates where `expected_charges > actual_charges` beyond
   the tolerance, with confidence based on signal strength.
7. Compute refund recommendation only when overcharges (rather than
   undercharges) are present, and only from bounded inputs.
8. Emit `runx.revenue.audit.v1` packet and meta block.

## Edge cases and stop conditions

Return `needs_input` when ledger or subscriptions are empty. Return
`refused` when private customer data is present. Never invent
subscriptions or line counts. Never propose a refund that exceeds the
overcharge present in the input.

Authority scope is audit packet composition only. The proof surface is
the sealed packet with leak_candidates, expected_vs_actual[],
refund_recommendation, confidence, stop_conditions, and handoff envelope.
Any live refund, dispute, or billing-system edit requires a separate
governed outbound skill.

## Output schema

The runner emits `runx.revenue.audit.v1`:

```json
{
  "leak_candidates": [
    {
      "subscription": "Acme Pro",
      "expected_charges": 1,
      "actual_charges": 0,
      "delta": 1,
      "confidence": 0.74,
      "match_basis": "amount_within_tolerance_pct",
      "window_days": 35
    }
  ],
  "expected_vs_actual": [
    { "subscription": "Acme Pro", "expected": 1, "actual": 0, "delta": 1 }
  ],
  "refund_recommendation": null,
  "stop_conditions": [
    "manual_review_required_for_high_value_discrepancies",
    "private_customer_data_not_to_leave_audit_skill"
  ],
  "handoff": {
    "next_skill": "governed-outbound",
    "requires_human_approval": true
  }
}
```

## Worked example

```bash
runx skill "$PWD" \
  --runner audit \
  --input-json ledger_lines='[
    {"date":"2026-07-01","amount_usd":99.00,"line_ref":"inv-001","vendor_hint":"acme pro"}
  ]' \
  --input-json known_subscriptions='[
    {"name":"Acme Pro","expected_amount_usd":99.00,"cadence_days":30}
  ]' \
  --input-json baseline_window_days=35 \
  --json
```

Expected result: `expected_vs_actual` shows expected=1, actual=1, delta=0;
`leak_candidates` is empty; `refund_recommendation` is null. The run
does not issue any refund or modify any billing system.

## Inputs

- `ledger_lines`: non-empty bounded array of `{date, amount_usd, line_ref,
  vendor_hint?}` records.
- `known_subscriptions`: non-empty bounded array of `{name,
  expected_amount_usd, cadence_days, last_seen_at?}` records.
- `baseline_window_days`: optional integer (default 35).
- `tolerance_pct`: optional float (default 0.15).

## Outputs

- `leak_candidates`: bounded list of subscriptions with charge gaps.
- `expected_vs_actual`: per-subscription delta envelope.
- `refund_recommendation`: bounded refund proposal (or null).
- `stop_conditions`: bounded escalation triggers.
- `handoff`: pointer to the next governed skill.