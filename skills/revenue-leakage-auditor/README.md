# Revenue Leakage Auditor

Bounded subscription audit packet composer.

## Inputs

- `ledger_lines[]` — non-empty array of bounded line records.
- `known_subscriptions[]` — non-empty array of subscription baseline.
- `baseline_window_days` — optional integer (default 35).
- `tolerance_pct` — optional float (default 0.15).

## Run

```bash
RUNX_INPUTS_PATH=fixtures/inputs.json node run.mjs | jq .
```

## Output schema

See `SKILL.md` for `runx.revenue.audit.v1`.

This skill is read-only by design; it never issues refunds, modifies
billing systems, disputes charges, or contacts payment providers.