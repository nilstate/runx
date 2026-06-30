---
name: vendor-risk-review
version: "0.1.0"
description: Relationship-level vendor risk judgment that records approved-with-conditions or rejected decisions against a supplied trust policy.
---

# vendor-risk-review

`vendor-risk-review` judges a vendor relationship against a supplied trust policy. It reads bounded contract text, vendor context, policy thresholds, and prior risk record state, then emits a relationship decision plus a data-store append event shape.

The skill is not a clause redliner and does not send stakeholder notifications. Its durable seam is the vendor risk record append through `registry:runx/data-store@0.1.2`; any notify step belongs to a separate governed `send-as` run.

## Inputs

- `contract_text`: bounded contract excerpt or summary.
- `vendor_context`: `{ vendor_ref, history, industry }`.
- `policy`: `{ required_sla_terms, max_liability, data_handling_floor, termination_window, policy_id, created_at }`.
- `data_source_ref`: public-safe source reference for the contract packet.
- `store_id`: pinned data-store identifier.
- `prior_risk_record`: optional `{ version }` read projection result.

## Decision rules

- Approve with conditions when the relationship is usable but recoverable gaps remain, such as an SLA floor miss or termination notice gap.
- Reject when liability is unbounded or above the policy cap, or when required data-handling evidence falls below the policy floor.
- Stop before writing when policy fields are missing, vendor identity is ambiguous, or prior state is unreadable.
- Every condition or rejection reason is grounded in a named supplied policy field.

## Output

The default runner emits:

- `decision`: `{ approved, rejected, reason, conditions, policy_id, created_at }`.
- `risk_record_event`: durable vendor risk event payload.
- `data_store_append_event`: CAS append evidence with store id, aggregate id, idempotency key, before/after version, and package ref.
- `record_written`: true when a complete policy and vendor identity allow the event.
- `escalation`: null for sealed decisions, `needs_human` only for stopped or ambiguous inputs.

## Validation

Run from the repository root:

```bash
runx harness ./skills/vendor-risk-review
```

Expected cases:

- `approve-with-conditions-sla-gap`
- `reject-unbounded-liability-data-floor`
- `missing-policy-stop`
