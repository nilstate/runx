# bookkeeper changelog

## 0.1.0

- Initial bookkeeper skill scaffold.
- `SKILL.md`: typed input/output contracts, refusal rules, decision rules.
- `X.yaml`: two inline harness cases — `clean-monthly-batch-sealed` (4 matched, 0 unmatched, ready) and `ambiguous-batch-needs-review` (1 matched, 1 unmatched, needs_more_evidence due to keyword tie).
- `run.mjs`: deterministic categorizer with explicit / vendor_memory / keyword_match / needs_review ladder; anomaly detection for duplicates, out-of-period, unknown payees, amount outliers, missing memos; reconciliation `{matched, unmatched, opening_balance, closing_balance, per_account[]}`.
- `fixtures/clean-monthly-batch.json`: deterministic inputs and expected outputs for the sealed case.
- `fixtures/ambiguous-batch.json`: deterministic inputs and expected outputs for the needs-review case.
- Local harness passes (`runx harness ./skills/bookkeeper`): `status=passed, case_count=2, assertion_error_count=0, receipt_ids=[sha256:6b71..., sha256:deee...]`.
- `runx doctor ./skills/bookkeeper` returns `0 error(s), 0 warning(s)`.
- `runx skill inspect ./skills/bookkeeper` returns `status=ok, version=0.1.0`.
- No self-funding, no wallet signature, no social engagement, no private login required. Pure typed I/O; the skill emits a read-only reconciliation artifact and never mutates a live ledger.
