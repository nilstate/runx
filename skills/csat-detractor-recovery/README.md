# CSAT Detractor Recovery

Bounded CSAT detractor recovery packet composer.

## Inputs

- `feedback` — non-empty text.
- `csat_score` — integer 0..10.
- `account_tier` — optional tier hint.
- `lifetime_value_usd` — optional LTV.
- `prior_complaints` — optional count.

## Run

```bash
RUNX_INPUTS_PATH=fixtures/inputs.json node run.mjs | jq .
```

## Output schema

See `SKILL.md` for `runx.csat.recovery.v1`.

This skill never sends email, issues credits, opens tickets, or mutates
CRM state. It composes a recovery packet; a separate governed skill can
review and approve any external action.