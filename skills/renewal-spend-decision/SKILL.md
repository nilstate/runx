---
name: renewal-spend-decision
version: 0.1.0
description: Turn a renewal brief (vendor, current_spend_usd, usage_signals[], alternative_options[]) into a bounded renewal decision packet. Reads renewal date, current spend, usage signals, and bounded alternative options, emits a typed decision packet with recommendation (renew, renegotiate, replace, drop), confidence, rationale, stop conditions, and handoff. Sends no notifications, makes no commitments, modifies no contracts.
source:
  type: cli-tool
  command: node
  args:
    - run.mjs
links:
  source: https://github.com/runxhq/runx/tree/main/skills/renewal-spend-decision
runx:
  category: ops
  input_resolution:
    required:
      - vendor
      - current_spend_usd
      - renewal_date
---

## What this skill does

Compose a bounded renewal decision packet from a bounded renewal brief.
The runner emits `runx.renewal.decision.v1` with `recommendation`,
`confidence`, `rationale`, `alternative_options_summary[]`,
`stop_conditions[]`, and `handoff`. The runner is deterministic; it never
sends vendor notifications, makes commitments, modifies contracts, or
mutates any spend ledger.

The skill proposes; a separate governed outbound skill can review,
approve, and emit authority grants before any external side effect runs.

## When to use this skill

Use this skill when an agent has a renewal brief and needs a calm
first-pass decision packet. It is useful in finance and procurement
rotations where the same bounded inputs need a bounded output every time.

It is intentionally read-only by design. It emits decisions; it never
enforces them.

## When not to use this skill

Do not use this skill to send vendor notifications, sign contracts, modify
spend ledgers, or trigger payments. Do not use it to override a finance
team's manual review. Do not use it as an automatic procurement tool.

If `vendor` is empty or `current_spend_usd` is missing, the skill
refuses with `needs_input`. If `usage_signals[]` carries private customer
data that has not been summarized, the skill refuses with `refused`.

## Procedure

1. Require `vendor` to be non-empty, `current_spend_usd` to be a number
   >= 0, and `renewal_date` to be a non-empty ISO date.
2. Accept optional `usage_signals[]` (each `{metric, value}`),
   `alternative_options[]` (each `{name, est_spend_usd, pros[], cons[]}`),
   `satisfaction_hint` (`low|medium|high`), and `strategic_value` (`low|medium|high`).
3. Compute `recommendation` from satisfaction + usage + alternatives:
   `low_satisfaction && has_alternative` -> replace; `low_satisfaction` ->
   renegotiate; `medium_satisfaction && no_usage_drop` -> renew;
   `high_satisfaction` -> renew; `no_usage_signals` -> renegotiate.
4. Compute `confidence` from how many bounded signals supported the
   recommendation (satisfaction_hint + usage_signals_present +
   alternative_options_present).
5. Compose `rationale` from inputs only; never invent facts.
6. Compose `alternative_options_summary[]` and `stop_conditions[]`.
7. Emit `runx.renewal.decision.v1` packet and meta block.

## Edge cases and stop conditions

Return `needs_input` when vendor or current_spend_usd is missing. Return
`refused` when private customer data is present. Never invent alternative
options. Never propose a recommendation stronger than the highest
satisfaction present in the input.

Authority scope is decision packet composition only. The proof surface is
the sealed packet with recommendation, confidence, rationale,
alternative_options_summary, stop_conditions, and handoff envelope. Any
live vendor notification, contract edit, or spend ledger mutation requires
a separate governed outbound skill.

## Output schema

The runner emits `runx.renewal.decision.v1`:

```json
{
  "recommendation": "renew | renegotiate | replace | drop",
  "confidence": 0.74,
  "rationale": "vendor=Acme; satisfaction_hint=low; usage_signals_present=true; alternative_options_present=true",
  "alternative_options_summary": [
    { "name": "Lumen Tier", "est_spend_usd": 1200, "pros_count": 2, "cons_count": 1 }
  ],
  "stop_conditions": [
    "spend_above_threshold_requires_finance_lead",
    "strategic_vendor_requires_executive_signoff"
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
  --runner decide \
  --input-json vendor='Acme Cloud' \
  --input-json current_spend_usd=2400 \
  --input-json renewal_date='2026-09-01' \
  --input-json satisfaction_hint='low' \
  --input-json usage_signals='[{"metric":"monthly_active_users","value":12}]' \
  --input-json alternative_options='[{"name":"Lumen Cloud","est_spend_usd":1800,"pros":["cheaper"],"cons":["migration"]}]' \
  --json
```

Expected result: `recommendation = replace`, `confidence >= 0.6`,
`rationale` references the inputs only. The run does not send any vendor
notification or modify any contract.

## Inputs

- `vendor`: non-empty vendor name.
- `current_spend_usd`: number >= 0.
- `renewal_date`: ISO date string.
- `usage_signals`: optional array of `{metric, value}` records.
- `alternative_options`: optional array of `{name, est_spend_usd,
  pros[], cons[]}` records.
- `satisfaction_hint`: optional `low|medium|high`.
- `strategic_value`: optional `low|medium|high`.

## Outputs

- `recommendation`: bounded first-pass decision.
- `confidence`: bounded confidence from signals.
- `rationale`: traceable rationale from inputs only.
- `alternative_options_summary`: bounded summary of alternatives.
- `stop_conditions`: bounded escalation triggers.
- `handoff`: pointer to the next governed skill.