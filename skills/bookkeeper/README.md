# bookkeeper

Native runx skill for read-only bookkeeping triage.

It accepts `transactions[]`, `chart_of_accounts`, and `prior_period`, then emits
`categorized[]`, `anomalies[]`, and `reconciliation{matched,unmatched}`. The
runner never creates a GL account or mutates a ledger. Ambiguous lines produce a
`needs_review` packet and a refused/failure receipt for the harness case.

```bash
runx harness . --json
runx skill . --input-json transactions="$(cat fixtures/clean-input.json)" --json
```
