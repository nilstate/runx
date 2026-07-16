---
name: bookkeeper
description: Categorize messy transactions against an existing chart of accounts, flag anomalies, and emit a read-only reconciliation packet without booking to a live ledger.
runx:
  category: data
---

# Bookkeeper

Turn messy transaction lines into clean books **without guessing**.

This skill is **read-only**. It never posts to a live ledger. It takes
`transactions[]`, `chart_of_accounts`, and optional `prior_period`, maps each
transaction onto an **existing** GL account, flags anomalies, and returns a
reconciliation artifact an operator can review.

## What this skill does

- Categorize each transaction to an account already present in
  `chart_of_accounts` (no inventing accounts).
- Flag anomalies: unknown counterparties, out-of-range amounts, unmapped
  descriptions, currency mismatches, duplicate-looking lines.
- Emit a reconciliation packet: mapped lines, unmapped lines, totals by
  account, anomaly list, residual risks.
- Return `needs_chart` when the chart is missing accounts required to map.
- Return `unsafe_request` if asked to book, post, transfer, or mutate money.

## Inputs

- `transactions` (required): array of `{id?, date?, description, amount, currency?, counterparty?}`
- `chart_of_accounts` (required): array or map of existing GL accounts with codes/names
- `prior_period` (optional): prior balances or mapped lines for continuity checks

## Output

- `mapped_lines`: categorized lines with `account_code`, `account_name`, `amount`, rationale
- `unmapped_lines`: lines that could not be safely categorized
- `anomalies`: structured flags with severity
- `totals_by_account`: rollups for review
- `reconciliation`: summary + residual risks
- `verdict`: `ready_for_review` | `needs_chart` | `unsafe_request`
