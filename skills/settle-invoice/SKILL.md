---
name: settle-invoice
description: Plan authority to settle a known invoice under a spend-bounded grant; this skill never moves money, and an approved downstream spend runner must execute payment.
runx:
  category: payments
---

# Settle Invoice

Settle one specific invoice that someone has already approved, without letting
the amount drift past the grant that authorizes it.

## What this skill does

`settle-invoice` produces a sealed `payment_plan` for one invoice. It binds the
invoice reference, the amount, the currency, the payee identity by account
digest, the rail, and the `requested_scope` authority ceiling that authorizes the
settlement. It decides one of `ready`, `over_budget`, or `needs_review`, and it
always requires human approval and a preflight check before the plan can be
executed.

The ceiling is the same typed `requested_scope` (an `AttenuationRequest`) the
`spend` and `refund` accepting runners narrow from. The downstream spend lane
reserves and mints the child grant against this exact ceiling, so the plan can
never widen authority beyond it.

The plan is the authority artifact, not the payment itself. Money moves only when
a downstream spend lane consumes an approved plan, records rail evidence, and the
runx receipt seals. This skill never holds funding material; it carries a payee
account digest or last4, never a full account number.

It settles a specific invoice where the counterparty, the invoice, and the
amount are fixed inputs. `x402-pay` answers a machine 402 signal and `charge`
authorizes a card; the difference here is that what is paid is already known, so
the only open questions are whether the amount fits the grant and whether a
person approves.

## When to use this skill

- An agent reconciling accounts payable has a specific invoice to settle and a
  grant that bounds how much it may spend.
- A workflow needs to prove that an invoice amount fit its authority ceiling
  before a person approved it.
- An operator wants one artifact that ties an invoice reference to a payee, a
  rail, and an approval decision for audit.
- A payable should be blocked, not paid, because its amount exceeds the bound it
  was granted under.

## When not to use this skill

- A machine payment-required challenge belongs to `x402-pay` or the canonical
  `spend` family with the matching runtime path.
- Authorizing a card or pricing an inbound paid call belongs to `charge`.
- Reversing a prior settlement belongs to `refund`.
- An unidentified payee, an unbounded amount, or an invoice you cannot reference
  stops the skill at `needs_agent`; it does not invent a counterparty.
- A full bank account number, card PAN, routing-plus-account pair, API key, or
  any raw funding credential is never accepted or emitted. The plan carries
  digests and refs only.

## Procedure

1. Validate the four required facts: `invoice_ref`, `amount`, `currency`, and
   `payee`. Any missing fact stops the skill at `needs_agent`.
2. Validate `requested_scope`. Without an authority ceiling there is nothing to
   settle against, so a missing ceiling also stops at `needs_agent`.
3. Reduce the payee to a stable identity: keep the display name and an
   `account_digest` (a hash of the account reference, or a last4). If only a raw
   account number is supplied, digest it and discard the raw value.
4. Compare `amount` against the `requested_scope` ceiling. If the amount exceeds
   the ceiling, decide `over_budget` and record the overage as a blocker. Do not
   round, split, or partially settle to fit under the ceiling.
5. Select the rail. Use the supplied `rail` when present; otherwise leave it
   unresolved and record a blocker so a downstream lane or operator must choose.
6. Set the gates. Human approval is always required. Preflight is always
   required. Neither is optional and neither defaults to satisfied.
7. Emit the smallest `payment_plan` a spend lane can execute without widening
   authority beyond the invoice, the payee, and the `requested_scope` ceiling.

## Edge cases and stop conditions

- **Missing invoice, amount, payee, or requested_scope ceiling:** return
  `needs_agent`. The skill does not guess a counterparty, an amount, or an
  authority ceiling.
- **Amount over the bound:** decide `over_budget`; record the overage; do not
  emit a plan that a lane could execute as-is.
- **Currency mismatch between amount and grant:** record a blocker and decide
  `needs_review`; this skill does not convert currency to force a fit.
- **Raw account number supplied:** digest it, keep only the digest or last4, and
  proceed; never echo the raw number into the plan or the receipt.
- **No rail resolvable:** decide `needs_review` with a rail blocker; a person or
  downstream lane must pick the rail.
- **Approval absent or denied:** the plan is never `ready`; settlement does not
  proceed.

Authority bounds the run. The `requested_scope` ceiling keeps the settlement
inside the supplied authority and `ledger:append` records the settlement intent;
no broader wallet scope is requested or implied. A `ready` decision means the
plan is well-formed and within the ceiling, not that money may move; the approval
and preflight gates still stand between the plan and any rail. The sealed receipt
carries the invoice reference, amount, currency, payee name and account digest,
rail, the requested authority ceiling, the decision, the gate state, and the
blocker list as proof, and never a full account number, card PAN, funding
credential, or raw secret.

## Output schema

```yaml
payment_plan:
  decision: ready | over_budget | needs_review
  invoice_ref: string
  amount: number
  currency: string
  payee:
    name: string
    account_digest: string
  rail: string
  requested_scope: object
  gates:
    human_approval_required: boolean
    preflight_required: boolean
  blockers: array
```

- `decision`: one of `ready`, `over_budget`, or `needs_review`.
- `payee.account_digest`: a hash or last4, never a full account number.
- `rail`: the selected settlement rail, or unresolved when none was supplied.
- `gates.human_approval_required` and `gates.preflight_required`: both always
  true.
- `blockers`: reasons the plan is not `ready`, for example an overage, an
  unresolved rail, or a currency mismatch.

## Worked example

Input: invoice `INV-2026-0412` for 1840.00 USD to Acme Hosting at account
`acct_3f9c1a7e`, under a `requested_scope` ceiling that authorizes up to 2500.00,
on the `ach` rail.

Output: `decision: ready`; the amount fits the ceiling, so no overage blocker; the
payee is reduced to a name and `account_digest`; the rail is `ach`; both
`human_approval_required` and `preflight_required` are true. The plan is
well-formed and within bound, but money does not move until an operator approves
and a downstream spend lane records rail evidence.

## Inputs

- `invoice_ref` (required): reference for the invoice being settled.
- `amount` (required): the settlement amount.
- `currency` (required): the settlement currency.
- `payee` (required): object naming the payee and its account by reference or
  digest, for example `{ "name": "Acme Hosting", "account_ref": "acct_..." }`.
  A raw account number is reduced to a digest and the raw value is dropped.
- `requested_scope` (required): the typed authority ceiling
  (`AttenuationRequest`) the settlement is authorized against; the same ceiling
  the `spend`/`refund` accepting runners narrow from. An amount over this ceiling
  forces an `over_budget` decision.
- `rail` (optional): the settlement rail to use, for example `ach`, `wire`, or a
  configured rail profile reference.
