---
name: purchase-approval
description: Read a cost-center budget, approve a bounded purchase, commit it with compare-and-swap, and consume the ceiling through a governed mock charge.
links:
  source: https://github.com/runxhq/runx/pull/307
runx:
  category: payments
---

# Purchase Approval

Use this skill before a purchase is committed. It reads the authoritative budget
projection keyed by `cost_center`, judges the request against procurement policy,
asks a person to confirm the grounded decision, records an approved purchase with
compare-and-swap, and passes the same bounded authority to `mock-charge`. The
shipped path is a deterministic mock rail: it spends no real money and requires
no wallet or payment secret.

## Inputs

- `data_source_ref`, optional provider-specific `store_id`, `budget_period`, and
  `cost_center` identify the authoritative budget projection.
- `idempotency_key` is the stable retry key for the approved budget event.
- `purchase_request`: `{ amount, currency, vendor, purpose }`.
- `procurement_policy`: `{ approved_vendors, max_single_purchase,
  requires_approval_above }`.
- `requested_scope`: `{ amount, currency, counterparty, scopes }`.
- `mcp_tool_call`, `provider_policy`, `returned_credential`,
  `verify_capability_ref`, and `charge_idempotency_seed` configure only the
  downstream mock charge.

There is deliberately no `current_budget_balance` input. The balance and stream
version come from `data.source read_projection` for the supplied cost center.

## Procedure

1. Read `budget_events` using `read_projection`, keyed by `cost_center` and
   `budget_period`.
2. Treat the returned `current_budget_balance`, currency, and version as
   authoritative. Never substitute a caller-supplied balance.
3. Require the vendor to be approved and the request to fit the stored balance,
   single-purchase cap, requested scope, and mock provider price.
4. Require request, projection, requested scope, and provider currency and
   counterparty to agree exactly; never convert currency or guess identity.
5. For an approved request, emit an exact `attenuation_request` and a
   `purchase.committed` budget event. A denial emits neither.
6. Stop at `purchase-approval.human-review`. No budget mutation or charge may
   execute until the person approves the grounded decision.
7. Append the budget event with `expected_version` taken directly from the
   earlier read. A version conflict stops the run instead of overspending.
8. Pass the exact `attenuation_request` as `parent_payment_authority` to
   `mock-charge`. Its receipt-before-forward workflow proves the ceiling is
   consumed by a payment rail rather than merely described.
9. Read the budget projection again so the receipt carries the updated version,
   committed spend, and remaining balance.

## Outputs and durable effects

The judgment packet contains `decision`, `attenuation_request`, `budget_event`,
and optional `escalation`. The durable seam records only approved events after
human review. The mock charge produces its own verification and sealed receipt;
it never contacts a real provider or transfers value.

## Stop rules

- Stop when the projection is absent, malformed, wrong-currency, or insufficient.
- Deny vendors or amounts outside policy or requested scope.
- Stop when mock provider price, currency, or counterparty differs from the
  approved request.
- Stop on compare-and-swap conflict; reread and reevaluate instead of retrying
  with a widened ceiling.
- Never append a budget event or invoke the charge rail for a denied,
  unconfirmed, or unresolved request.
- Never accept wallet keys, provider secrets, or real payment credentials.

## Harness-only fixture

`purchase-approval-with-budget-fixture` seeds a local cost-center budget before
calling the normal runner. It exists only to prove a 2200 balance becomes 1720
at version 2 after one approved 480 mock charge, while the over-budget case
stops at `needs_agent` before any purchase commit or charge.
