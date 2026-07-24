# Bookkeeper

A bounded read-only reconciliation skill for the runx platform.

## Inputs

- `transactions[]` — non-empty array of `{id, date, amount, currency,
  description, vendor?, account_code?}` records.
- `chart_of_accounts[]` — non-empty array of `{code, name, kind,
  keywords?, default_currency?}` records.
- `prior_period` — optional `{closing_balance_usd, tolerance}` envelope for
  carry-forward drift checks.

## Run

```bash
node run.mjs < fixtures/inputs.json > fixtures/expected_output.json
# or via runx:
runx skill "$PWD" --runner reconcile --input-json transactions@fixtures/inputs.json --json
```

## Output schema

See `SKILL.md` for the full `runx.bookkeeper.reconciliation.v1` packet spec.

## Tests

```bash
# Fixture-driven smoke run:
RUNX_INPUTS_PATH=fixtures/inputs.json node run.mjs | jq .
```

## Local proof

- `fixtures/inputs.json` — 6 transactions across income / expense kinds with
  one missing date, one round-number amount, and one zero entry.
- `fixtures/expected_outputs.json` — assertions used by the harness.

This skill is intentionally read-only: it never writes to a live ledger, never
opens bank rails, and never makes external API calls.