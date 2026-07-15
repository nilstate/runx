---
name: stripe-pay
description: Execute a governed Stripe Shared Payment Token spend by delegating to the canonical spend flow with the stripe-spt runtime path selected.
runx:
  category: payments
---

# Stripe Pay

Execute a governed outbound payment through Stripe Shared Payment Tokens.

This is a branded catalog skill over the canonical `spend` family. It exists
because Stripe is the surface operators recognize, while runx still owns the
authority, gate, finality, and receipt semantics. The skill selects runtime path
`stripe-spt`, passes only scoped references to the rail runner, and seals the
canonical spend receipt with Stripe evidence attached.

## What this skill does

`stripe-pay` turns a payment-required signal into a Stripe SPT-backed governed
spend: quote, reserve, approval when required, scoped token settlement evidence,
recovery posture, and receipt-before-success.

It does not accept Stripe secret keys, webhook secrets, PANs, card data, or raw
unrestricted provider tokens as agent-visible input or output. It does not
bypass the canonical spend reservation or treat a Stripe event as final without
a sealed runx receipt.

## When to use this skill

- A paid action should settle through a configured Stripe SPT profile.
- The operator wants a Stripe-branded catalog surface while keeping canonical
  spend receipts.
- A Stripe test-mode or hosted connector path is configured and must be
  exercised through runx authority.
- The agent needs a receipt binding Stripe evidence to quote, reservation,
  approval, idempotency, and redaction decisions.

## When not to use this skill

- To settle through x402, MPP, CDP, or mock fixtures. Use the matching branded
  skill or `spend` with the selected runtime path.
- To charge another agent for a runx-hosted service. Use `charge`.
- To issue a refund. Use `refund` or a future Stripe-branded refund facade.
- To run Stripe just because a secret key exists. The runtime path must be
  selected by signal and policy.
- To expose or request raw Stripe secrets from the agent. Return `needs_agent`
  when only raw material is available.

## Procedure

1. Validate that the payment signal and policy select runtime path `stripe-spt`.
   If another path is requested, stop with `needs_agent`.
2. Validate `parent_payment_authority` and `rail_profile_ref`. The authority
   must cover the amount, currency, counterparty, operation, realm, and
   `stripe-spt` channel.
3. Delegate to `spend` runner/runtime path `stripe-spt` with the original
   signal, parent authority, Stripe profile reference, policy, approval context,
   and idempotency seed.
4. Require quote and reservation before the Stripe rail runner receives any
   spend capability.
5. Pause at the spend approval gate when required. A denied or missing approval
   prevents Stripe fulfillment.
6. Fulfill through the scoped Stripe SPT rail runner. The local runner supports
   explicit test profiles without credentials. Live settlement requires a
   hosted payment provider that owns credential custody; the graph passes only
   references and capability bindings and refuses local live profiles.
7. Record Stripe evidence as provider event refs, charge/payment-intent refs,
   scoped token refs, hashes, and redaction notes. Never emit raw API keys,
   webhook secrets, card data, or unrestricted token material.
8. If Stripe state is ambiguous, return `escalated` with recovery hints and
   preserve the same idempotency key.
9. Return success only after the canonical spend receipt seals with Stripe
   evidence attached.

## Edge cases and stop conditions

- **Non-Stripe path:** return `needs_agent`; this facade must not silently route
  to another runtime path.
- **Missing hosted/local Stripe profile:** return `needs_agent`; do not ask the
  agent to paste raw secrets.
- **Local live profile:** refuse and route to a hosted payment provider; the
  external-adapter boundary intentionally does not inherit ambient secrets.
- **Amount or counterparty drift:** stop when Stripe-side state differs from the
  reserved quote.
- **Approval missing or denied:** do not call Stripe.
- **Raw card or provider secret in input:** refuse or redact and return
  `needs_agent`.
- **Ambiguous provider state:** return `escalated` and require recovery before
  retry.
- **Unsealed receipt:** return `escalated`; Stripe evidence without a runx seal
  is not a completed governed spend.

## Output schema

```yaml
decision: sealed | denied | needs_agent | escalated
canonical_skill: runx/spend
runtime_path: stripe-spt
payment_execution:
  payment_quote_packet: object
  payment_reservation_packet: object
  payment_approval: object
  effect_evidence_packet:
    rail_result: object
    rail_proof:
      stripe_charge_ref: string | null
      payment_intent_ref: string | null
      provider_event_ref: string | null
      shared_payment_token_ref: string | null
      admission_token_digest: string | null
    redactions: [string]
    recovery_hint: object | null
sealed_receipt_ref: string | null
open_questions: [string]
```

## Worked example

A paid data endpoint returns a `1.25 USD` payment signal and policy selects
`stripe-spt`. The parent grant allows a single payment commit for that amount,
counterparty, and operation. `stripe-pay` delegates to `spend:stripe-spt`,
reserves a child authority, records approval, fulfills through the Stripe SPT
runtime path using scoped credential references, redacts provider secret
material, and returns `decision: sealed` only after the receipt binds the Stripe
charge/event refs to the spend proof.

If the Stripe runner reports an indeterminate provider state, the skill returns
`escalated` with the idempotency key and recovery hint. It does not create a new
payment attempt under a new key.

## Inputs

- `payment_signal` (required): payment-required signal or challenge.
- `parent_payment_authority` (required): parent payment authority term or
  authority reference.
- `rail_profile_ref` (required): configured Stripe SPT runtime-path profile
  reference.
- `realm` (optional): authority realm such as `local`, `test`, or `prod`.
- `spend_policy` (optional): policy limits and approval thresholds.
- `approval_context` (optional): prior approval evidence.
- `idempotency_seed` (optional): stable idempotency material.
