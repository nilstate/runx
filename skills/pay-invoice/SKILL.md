---
name: pay-invoice
description: Settle a known, approved invoice under a spend-bounded grant, with explicit human approval before money moves.
runx:
  category: payments
---

# Pay Invoice

Settle one specific invoice that someone has already approved, without letting
the amount drift past the grant that authorizes it.

A bill arrives with a number, a payee, and an amount. An agent reconciling
accounts payable knows which invoice to pay but should not be the actor that
decides money may move. This skill turns that known, named invoice into a bounded
payment plan: it binds the invoice reference, checks the amount against a spend
limit, fixes the payee to an account digest, and stops at a human approval gate
before any rail is touched.

It settles a specific invoice; x402-pay answers a machine 402 signal and charge
authorizes a card. The difference is what is already known. Here the
counterparty, the invoice, and the amount are fixed inputs; the only open
questions are whether the amount fits the grant and whether a person approves.

## What this skill does

`pay-invoice` produces a sealed `payment_plan` for one invoice. It binds the
invoice reference, the amount, the currency, the payee identity by account
digest, the rail, and the spend bound that authorizes the settlement. It decides
one of `ready`, `over_budget`, or `needs_review`, and it always requires human
approval and a preflight check before the plan can be executed.

The plan is the authority artifact, not the payment itself. Money moves only when
a downstream spend lane consumes an approved plan, records rail evidence, and the
runx receipt seals. This skill never holds funding material; it carries a payee
account digest or last4, never a full account number.

## When to use this skill

- An agent reconciling accounts payable has a specific invoice to settle and a
  grant that bounds how much it may spend.
- A workflow needs to prove that an invoice amount fit its spend limit before a
  person approved it.
- An operator wants one artifact that ties an invoice reference to a payee, a
  rail, and an approval decision for audit.
- A payable should be blocked, not paid, because its amount exceeds the bound it
  was granted under.

## When not to use this skill

- To answer a machine payment-required challenge. Use `x402-pay` or the canonical
  `spend` family with the matching runtime path.
- To authorize a card or price an inbound paid call. Use `charge`.
- To issue or reverse a refund against a prior settlement. Use `refund`.
- To pay an unidentified payee, an unbounded amount, or an invoice you cannot
  reference. The skill returns `needs_agent` instead of inventing a counterparty.
- To accept or emit a full bank account number, card PAN, routing-plus-account
  pair, API key, or any raw funding credential. The plan carries digests and
  refs only.

## Procedure

1. Validate the four required facts: `invoice_ref`, `amount`, `currency`, and
   `payee`. Any missing fact stops the skill at `needs_agent`.
2. Validate `spend_limit`. Without a bound there is no authority to settle
   against, so a missing limit also stops at `needs_agent`.
3. Reduce the payee to a stable identity: keep the display name and an
   `account_digest` (a hash of the account reference, or a last4). If only a raw
   account number is supplied, digest it and discard the raw value.
4. Compare `amount` against `spend_limit`. If the amount exceeds the bound, decide
   `over_budget` and record the overage as a blocker. Do not round, split, or
   partially settle to fit under the limit.
5. Select the rail. Use the supplied `rail` when present; otherwise leave it
   unresolved and record a blocker so a downstream lane or operator must choose.
6. Set the gates. Human approval is always required. Preflight is always
   required. Neither is optional and neither defaults to satisfied.
7. Emit the smallest `payment_plan` a spend lane can execute without widening
   authority beyond the invoice, the payee, and the spend bound.

## Edge cases and stop conditions

- **Missing invoice, amount, payee, or spend limit:** return `needs_agent`. The
  skill does not guess a counterparty, an amount, or an authority bound.
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

## Governance

- **Scopes:** `wallet:spend <= spend_limit` bounds the settlement to the supplied
  limit; `ledger:append` records the settlement intent. No broader wallet scope
  is requested or implied.
- **Spend bound:** enforced in the decision. When `amount > spend_limit` the
  decision is `over_budget` and the plan cannot be executed.
- **Gates:** `human_approval_required` is always true; `preflight_required` is
  always true. A `ready` decision means the plan is well-formed and within bound,
  not that money may move; the approval and preflight gates still stand between
  the plan and any rail.
- **Receipt carries:** the invoice reference, amount, currency, payee name and
  account digest, rail, spend limit, the decision, the gate state, and the
  blocker list. The receipt never carries a full account number, card PAN,
  funding credential, or any raw secret value.

## Output

`payment_plan` is an object with these fields:

- `decision`: one of `ready`, `over_budget`, or `needs_review`.
- `invoice_ref`: the invoice reference being settled.
- `amount`: the settlement amount.
- `currency`: the settlement currency.
- `payee`: object with `name` and `account_digest`. Never a full account number;
  use a digest or last4.
- `rail`: the selected settlement rail, or unresolved when none was supplied.
- `spend_limit`: the bound the settlement is authorized against.
- `gates`: object with `human_approval_required` and `preflight_required`, both
  always true.
- `blockers`: array of reasons the plan is not `ready`, for example an overage,
  an unresolved rail, or a currency mismatch.

## Inputs

- `invoice_ref` (required): reference for the invoice being settled.
- `amount` (required): the settlement amount.
- `currency` (required): the settlement currency.
- `payee` (required): object naming the payee and its account by reference or
  digest, for example `{ "name": "Acme Hosting", "account_ref": "acct_..." }`.
  A raw account number is reduced to a digest and the raw value is dropped.
- `spend_limit` (required): the bound the settlement is authorized against.
- `rail` (optional): the settlement rail to use, for example `ach`, `wire`, or a
  configured rail profile reference.

## Quality Profile

- Purpose: turn one known, approved invoice into a bounded, approvable settlement
  plan that proves the amount fit its grant before any money moves.
- Audience: the operator approving the payable, and the downstream spend lane or
  receipt review that executes or audits the settlement.
- Artifact contract: a `payment_plan` object carrying `decision`, `invoice_ref`,
  `amount`, `currency`, `payee` (with `account_digest`, never a full number),
  `rail`, `spend_limit`, `gates` (`human_approval_required` and
  `preflight_required`, both true), and `blockers`.
- Evidence bar: the decision must be derivable from the inputs. An `over_budget`
  decision must name the overage; a `needs_review` decision must name the
  unresolved fact (rail, currency, or other) in `blockers`. No claim that money
  moved; this skill produces a plan, not a settlement.
- Voice bar: terse operator-to-ledger prose. State the decision and the bound
  plainly. No reassurance about safety, no narration of the approval flow.
- Strategic bar: the plan must make one human decision easier, approve or hold a
  specific payable, while making it impossible to settle past the granted bound
  without a person seeing it.
- Stop conditions: return `needs_agent` when the invoice reference, amount,
  payee, or spend limit is missing; decide `over_budget` when the amount exceeds
  the spend limit; decide `needs_review` when the rail or currency cannot be
  resolved against the grant.
