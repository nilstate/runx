---
name: settle-invoice
description: Validate one invoice against a real payment authority and prepare an executable canonical spend handoff without moving money.
runx:
  category: payments
---

# Settle Invoice

Prepare one invoice for the canonical `spend` lane. The native
`payment.invoice_plan` tool validates the invoice, payee identity, selected
rail, profile, idempotency seed, and complete parent payment AuthorityTerm.

Use this skill when an invoice is the source business document and the operator
needs to know whether it can be represented as one exact governed payment. It
keeps invoice validation separate from money movement: a ready result is a
reviewable `spend` handoff, not a paid invoice. Use `spend` directly when the
payment signal is already structured and validated.

This skill plans only. It never approves a spend, contacts a provider, moves
money, or claims settlement. A ready plan has `provider_effect.status:
not_started` and `money_moved: false`.

## Contract

- Amounts are positive integer minor units and currency is uppercase ISO 4217.
- The payee has `name`, `party_ref`, and exactly one opaque
  `settlement_ref` or SHA-256 `settlement_digest`. Raw account and routing
  fields are refused.
- `parent_payment_authority` is a full typed term. Native quote validation
  requires bounded per-call and aggregate limits, the selected rail, realm,
  payee, `invoice.settle` operation, and single-use capability authority.
- Supported executable handoff rails are `mock`, `mpp`, and `stripe-spt`,
  matching actual `spend` runners. Unsupported rails return `blocked`; the
  skill never labels an unavailable ACH or x402 path ready.
- `rail_profile_ref` and `idempotency_seed` are explicit and pass unchanged.
  Hosted `payment_admission` and realm pass through only when supplied.

A `ready_for_spend` plan names `skill: spend`, the executable runner, and
the exact validated inputs. A blocked plan has no downstream handoff and lists
the failed bounds. Approval and rail evidence belong to downstream `spend`.

## Stop conditions

- Block missing invoice identity, non-positive or non-integer minor units,
  malformed currency, or ambiguous payee identity.
- Refuse raw bank-account or routing material; accept only an opaque settlement
  ref or stable settlement digest.
- Block an unsupported rail or any invoice outside the parent authority's
  amount, currency, counterparty, operation, realm, or aggregate bounds.
- Do not interpret an existing approval note as downstream spend approval.
- Preserve the same profile and idempotency seed in the handoff; do not silently
  regenerate them.

## Example

An invoice for `25000 AUD` identifies a supplier by party ref and opaque Stripe
settlement ref. If the parent authority permits that supplier, currency,
`invoice.settle` operation, rail, and ceiling, the skill returns the exact
`spend:stripe-spt` inputs. If the invoice requests ACH—which no canonical runner
supports—the result is blocked rather than a vague “ready” plan. In both cases,
no payment has occurred.
