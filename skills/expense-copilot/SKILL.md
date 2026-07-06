---
name: expense-copilot
description: Extract a reimbursement receipt, check it against policy limits and categories, and emit a gated reimbursement_proposal only when policy passes.
source:
  type: cli-tool
  command: node
  args:
    - run.mjs
  timeout_seconds: 30
  sandbox:
    profile: readonly
    cwd_policy: skill-directory
    require_enforcement: false
inputs:
  receipt:
    type: json
    required: true
    description: receipt{merchant, amount, currency, category, date, employee_id, description}
  policy:
    type: json
    required: true
    description: policy{limits,categories}
runx:
  category: finance
  input_resolution:
    required:
      - receipt
      - policy
---

# Expense Copilot

`expense-copilot` is a read-only reimbursement preflight skill. It reads one
receipt fixture and one expense policy, extracts grounded expense fields, checks
the category and amount against policy, and emits a gated
`reimbursement_proposal` only when every policy rule passes.

The skill never reimburses, never calls a money rail, never writes accounting
state, and never invents missing receipt fields. A downstream governed `spend`
run may consume the proposal; this skill only produces the proposal data.

## Contract

Inputs:

- `receipt{merchant, amount, currency, category, date, employee_id, description}`
- `policy{limits,categories}`

Output:

- `extracted`
- `policy_result{pass, violations}`
- `reimbursement_proposal` when policy passes
- `escalation` when policy fails or the receipt is ungrounded

## Policy behavior

- The receipt category must be in `policy.categories`.
- The receipt amount must be a non-negative number.
- The receipt amount must be at or below `policy.limits[category]`.
- Required fields must be present; missing merchant, amount, currency, category,
  date, or employee_id causes escalation.
- The skill names every violated rule and emits no `reimbursement_proposal` when
  policy does not pass.

## Verification

Local harness:

```bash
runx harness ./skills/expense-copilot
```

Example dogfood run:

```bash
runx skill ./skills/expense-copilot --json \
  --input-json receipt='{"merchant":"Rail Cafe","amount":42.75,"currency":"USD","category":"meals","date":"2026-07-01","employee_id":"emp_104","description":"Dinner during customer onsite travel"}' \
  --input-json policy='{"limits":{"meals":75,"travel":500,"supplies":150},"categories":["meals","travel","supplies"]}'
```
