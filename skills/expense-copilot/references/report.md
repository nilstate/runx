# Expense Copilot verification report

Package: `lxx197818/expense-copilot@sha-66f09fbe6b8a`

Public registry URL: <https://runx.ai/x/lxx197818/expense-copilot>

## What the skill does

`expense-copilot` reads a reimbursement receipt and an expense policy, extracts
grounded receipt fields, checks category and amount against the policy, and
emits a gated `reimbursement_proposal` only when the policy passes.

The skill does not reimburse, does not call a money rail, and does not write
accounting state. The proposal is intended for a separate governed `spend` run.

## Validation performed

- `runx --version`: `runx-cli 0.6.14`
- Local harness passed for:
  - `in_policy_receipt_proposes_reimbursement`
  - `over_limit_receipt_refuses_reimbursement`
- Registry publish succeeded for `lxx197818/expense-copilot@sha-66f09fbe6b8a`
- Post-publish dogfood run sealed receipt:
  - `runx:receipt:sha256:20893020a70a51c3bebc7ffb0824055cbc546ea0a7918742bf146273cfa3d1d3`
- `runx verify` returned `valid: true`

## Dogfood observation

Input receipt:

- merchant: Rail Cafe
- amount: 42.75 USD
- category: meals
- employee: emp_104

Policy:

- meals limit: 75 USD
- allowed categories: meals, travel, supplies

Result:

- `policy_result.pass`: true
- `policy_result.violations`: []
- `reimbursement_proposal`: present
- `effects.reimbursement_executed`: false
- `effects.money_rail`: false
- `effects.accounting_state_written`: false

## How to install and run

```bash
runx add lxx197818/expense-copilot@sha-66f09fbe6b8a --registry https://api.runx.ai
runx skill lxx197818/expense-copilot@sha-66f09fbe6b8a --registry https://api.runx.ai --json \
  --input-json receipt='{"merchant":"Rail Cafe","amount":42.75,"currency":"USD","category":"meals","date":"2026-07-01","employee_id":"emp_104","description":"Dinner during customer onsite travel"}' \
  --input-json policy='{"limits":{"meals":75,"travel":500,"supplies":150},"categories":["meals","travel","supplies"]}'
```
