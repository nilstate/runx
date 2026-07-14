---
name: bookkeeper
description: Categorize transaction batches into an existing chart of accounts and emit read-only reconciliation evidence without mutating a ledger.
source:
  type: cli-tool
  command: node
  args:
    - run.mjs
  timeout_seconds: 30
  sandbox:
    profile: readonly
    cwd_policy: skill-directory
inputs:
  transactions:
    type: json
    required: true
    description: Array of transaction lines with id, date, description, amount, currency, and optional counterparty.
  chart_of_accounts:
    type: json
    required: true
    description: Array of existing GL accounts. Each account needs code, name, type, and optional keywords.
  prior_period:
    type: json
    required: true
    description: Prior-period summary used only for anomaly comparison, never for mutation.
runx:
  category: finance-ops
  input_resolution:
    required:
      - transactions
      - chart_of_accounts
      - prior_period
---

# bookkeeper

`bookkeeper` turns messy transaction batches into a read-only accounting
artifact. It assigns each transaction to an existing GL account from the
provided `chart_of_accounts`, reports anomalies, and reconciles matched and
unmatched totals. It never books entries to a live ledger and it never creates a
new GL account.

Use this skill when an operator has exported transactions and wants a governed
first-pass categorization packet that a human bookkeeper can inspect. The runner
is deterministic and local: it reads only the supplied JSON inputs, performs
keyword and account-code matching, and emits a JSON artifact with confidence and
reason for every categorized line.

## Inputs

- `transactions`: array of transaction objects with `id`, `date`,
  `description`, `amount`, `currency`, and optional `counterparty`.
- `chart_of_accounts`: array of existing accounts with `code`, `name`, `type`,
  and optional `keywords`.
- `prior_period`: object with optional `currency`, `average_transaction_amount`,
  `total_income`, `total_expense`, and `known_counterparties`.

## Output

The runner emits:

- `categorized[]`: one entry per matched transaction, including `transaction_id`,
  `account_code`, `account_name`, `confidence`, and `reason`.
- `anomalies[]`: suspicious, oversized, unsupported-currency, duplicate, or
  needs-review observations.
- `reconciliation`: `{matched, unmatched}` totals and line counts.

## Stop Conditions

Return `needs_review` and refuse automatic categorization when any transaction
cannot be bound to an existing account with enough confidence. The packet names
the ambiguous transaction IDs and the available account universe so a human can
decide without the skill inventing a GL account.
