---
name: bookkeeper
version: 0.1.0
description: Turn messy transaction lines into clean books without guessing. Reads transactions[], chart_of_accounts, and prior_period, categorizes each transaction to an existing GL account, flags anomalies, and emits a read-only reconciliation artifact. Books nothing to a live ledger.
source:
  type: cli-tool
  command: node
  args:
    - run.mjs
links:
  source: https://github.com/runxhq/runx/tree/main/skills/bookkeeper
runx:
  category: ops
  input_resolution:
    required:
      - transactions
      - chart_of_accounts
---

## What this skill does

Categorize a flat transaction stream into a GL using a bounded, deterministic
matching rule against a user-supplied chart of accounts. The runner emits a
`bookkeeper.reconciliation.v1` packet that lists, per transaction, the matched
account (or `unmatched`), the rule that fired, confidence, and whether the line
looks anomalous. It also surfaces an aggregate `anomalies[]` array and a
`reconciliation_summary` block.

This skill never writes to any live ledger, never opens bank rails, never
moves money, and never makes external API calls. It is a deterministic local
reconciliation engine that turns transaction lines into a clearly-flagged,
reviewable proposal.

## When to use this skill

Use this skill when an operator needs to bring an unordered transaction export
into a stable GL structure for review. It is useful in:

- book-closing pipelines where the same `chart_of_accounts` is reused period
  over period and `prior_period` data is available for carry-forward checks
- review queues where anomaly flags drive a downstream human-audit workflow
- dry-run validation of GL mappings before committing to a real ERP

It is intentionally read-only. It never mutates the supplied input and never
opens external connections.

## When not to use this skill

Do not use this skill as a ledger-of-record, automated GL writer, tax
classifier, or anything that emits an authoritative accounting record. Do not
use it as a transaction-recognition or merchant-discovery system — the chart
must already exist. Do not use it to merge accounts, fix typos, or write to a
master chart.

If the input `chart_of_accounts` is empty, or `transactions` is empty, or
`prior_period` carries forward balances that disagree with the current period
totals, the skill emits a clearly-flagged output. It does not invent accounts
or numbers to fill the gap.

## Procedure

1. Require `transactions[]` to be a non-empty array of objects with at least
   `id`, `amount`, `currency`, `date`, and `description`.
2. Require `chart_of_accounts` to be a non-empty array of objects with at least
   `code`, `name`, and `kind` (`asset`, `liability`, `income`, `expense`,
   `equity`).
3. For each transaction, compute candidate matches against the chart by:
   - exact `account_code` if supplied,
   - otherwise token-overlap between description and account name,
   - otherwise vendor keyword matching against `keywords[]` on the account,
   - otherwise amount-band routing for income/expense kinds.
4. Pick the highest-confidence candidate above `min_confidence` (default
   `0.45`); if none, classify the line as `unmatched`.
5. Compute anomaly flags: missing date, missing currency, amount mismatched
   against prior-period expectation, vendor reversal, suspicious round number
   on a single line, or unmatched with confidence above `0.45` but below
   `0.7`.
6. Aggregate `reconciliation_summary`: totals by kind, match coverage rate,
   anomaly count, and carry-forward drift when `prior_period` is provided.
7. Emit `runx.bookkeeper.reconciliation.v1` with the packet and the run summary.

## Edge cases and stop conditions

- Empty `transactions` or `chart_of_accounts` returns `needs_input` with a
  reason; never invents data.
- Ambiguous transactions (no match above `min_confidence`) are returned as
  `unmatched` and flagged; never guessed.
- Currency mismatches between transactions and chart are surfaced as
  `anomaly` rather than silently converted.
- Carry-forward drift above `prior_period.tolerance` is surfaced as
  `reconciliation_summary.carry_forward_drift` and a single top-level
  `anomaly` so reviewers cannot miss it.
- Inputs that ask the skill to write to a ledger, post to a remote service, or
  bypass the human review step return `refused`.

The authority scope is local reconciliation and proposal only. The proof
surface is the sealed packet containing the per-transaction decisions, the
anomaly list, and the reconciliation summary. No live ledger write is ever
emitted.

## Output schema

The runner emits `runx.bookkeeper.reconciliation.v1`:

```json
{
  "period": {
    "from": "2026-07-01",
    "to": "2026-07-31"
  },
  "summary": {
    "transaction_count": 12,
    "matched_count": 10,
    "unmatched_count": 2,
    "anomaly_count": 3,
    "by_kind": {
      "income": 412.50,
      "expense": -188.20,
      "asset": 0.00,
      "liability": 0.00,
      "equity": 0.00
    },
    "match_coverage_rate": 0.83,
    "carry_forward_drift": null
  },
  "decisions": [
    {
      "transaction_id": "tx-2026-07-001",
      "matched_account_code": "4000-revenue-services",
      "matched_account_name": "Services Revenue",
      "match_rule": "token_overlap:invoice",
      "confidence": 0.82,
      "anomalies": [],
      "notes": ""
    }
  ],
  "anomalies": [
    {
      "transaction_id": "tx-2026-07-009",
      "kind": "currency_mismatch",
      "detail": "transaction currency=USD; chart default currency=EUR",
      "severity": "medium"
    }
  ]
}
```

## Worked example

```bash
runx skill "$PWD" \
  --runner reconcile \
  --input-json transactions='[
    {"id":"tx-1","date":"2026-07-03","amount":250.00,"currency":"USD","description":"Invoice 1042 — consulting"},
    {"id":"tx-2","date":"2026-07-05","amount":-12.99,"currency":"USD","description":"Domain renewal"}
  ]' \
  --input-json chart_of_accounts='[
    {"code":"4000","name":"Services Revenue","kind":"income","keywords":["invoice","consulting"]},
    {"code":"6300","name":"Subscriptions","kind":"expense","keywords":["domain","subscription"]}
  ]' \
  --input-json prior_period='{"closing_balance_usd":1200.50,"tolerance":25.00}' \
  --json
```

Expected result: `decisions` lists `tx-1` matched to `4000` and `tx-2` matched to
`6300`; `summary.matched_count = 2`; `summary.carry_forward_drift` is reported
when the current period does not reconcile to `prior_period.closing_balance_usd`
plus `±prior_period.tolerance`.

## Inputs

- `transactions`: array of `{id, date, amount, currency, description,
  vendor?, account_code?}` records.
- `chart_of_accounts`: array of `{code, name, kind, keywords?, default_currency?}`
  records.
- `prior_period`: optional `{closing_balance_usd, tolerance}` envelope.

## Outputs

- `period`: the `{from, to}` envelope echoed back for the runner.
- `summary`: aggregated totals and coverage rate.
- `decisions`: per-transaction match record with rule, confidence, and notes.
- `anomalies`: top-level anomaly list with kind, severity, and detail.