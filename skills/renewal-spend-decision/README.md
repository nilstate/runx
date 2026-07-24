# Renewal Spend Decision

Bounded renewal decision packet composer.

## Inputs

- `vendor` — non-empty vendor name.
- `current_spend_usd` — number >= 0.
- `renewal_date` — ISO date string.
- `usage_signals[]`, `alternative_options[]`, `satisfaction_hint`,
  `strategic_value` — optional hints.

## Run

```bash
RUNX_INPUTS_PATH=fixtures/inputs.json node run.mjs | jq .
```

## Output schema

See `SKILL.md` for `runx.renewal.decision.v1`.

This skill is read-only by design; it never sends vendor notifications,
modifies contracts, or mutates any spend ledger.