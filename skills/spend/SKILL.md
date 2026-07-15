---
name: spend
description: Execute one governed outbound payment across a selected runtime path, with quote, reservation, approval, rail evidence, recovery, and receipt-before-success.
runx:
  category: payments
---

# Spend

Execute one governed outbound payment.

This skill is the public buyer-side payment verb. It turns a payment-required
signal into a quote, reserves a child payment authority under the parent grant,
passes an approval gate when required, fulfills exactly one runtime path, and
returns rail evidence that must seal before the paid action can be treated as
successful.

The runtime path is not a separate authority model. Stripe SPT, x402, MPP, and
mock are selectable paths inside the same governed spend. Some paths also have
branded catalog facades (`x402-pay`, `stripe-pay`) because those names help
users discover and invoke the capability, but those facades still execute this
same quote -> reserve -> approve -> fulfill -> seal flow.

## What this skill does

1. **Normalize the payment signal.** Use `pay-quote` to bind amount, currency,
   operation, counterparty, candidate runtime paths, realm, expiry, and
   idempotency material.
2. **Reserve authority.** Use `pay-reserve` to prove the child spend authority is
   a subset of the parent payment grant and to mint a single-use spend
   capability reference.
3. **Gate the mutation.** Require approval when policy or realm demands it. A
   rail runner must not receive spend authority until the gate records an
   approved decision.
4. **Fulfill exactly one runtime path.** Use `pay-fulfill-rail` with the selected
   runner (`mock`, `x402`, `mpp`, or `stripe-spt`) and carry only scoped
   capability references, never raw funding material.
5. **Preserve recovery evidence.** If the rail response is ambiguous, report the
   idempotency state and recovery hint instead of retrying under a new key.
6. **Seal before success.** The spend is successful only when the receipt carries
   quote, reservation, approval, rail proof, redaction notes, and finality.

It does not decide provider-side pricing, verify inbound customer credentials,
settle a refund, answer a dispute, or expose unrestricted rail credentials.

## When to use this skill

- A tool, service, or counterparty returns a payment-required signal and the
  caller has a parent payment authority grant.
- A harness needs to exercise the same governed spend flow over multiple
  runtime paths.
- An operator wants one receipt chain that proves quote, reservation, approval,
  rail fulfillment, and recovery posture for an outbound payment.
- A future real-rail demo needs to swap a deterministic mock path for x402,
  Stripe SPT, MPP, or CDP without changing the canonical spend semantics.

## When not to use this skill

- To price an inbound service that runx exposes to another agent. Use
  `charge-price` and `charge-verify`.
- To issue or reverse a refund. Use the refund verb when it lands, preserving
  the original charge/spend receipt link.
- To run a rail directly because credentials are available. Runtime paths are
  children of this skill and must receive only scoped spend capability refs.
- To retry after a timeout with a new idempotency key. Recover under the same
  reservation first.
- To accept raw API keys, card numbers, unrestricted provider tokens, seed
  phrases, webhook secrets, or bearer tokens as skill inputs.

## Procedure

1. Validate `payment_signal`, `parent_payment_authority`, and
   `rail_profile_ref`.
2. Select the runtime path from the signal and allowed policy. If more than one
   path is possible, select by policy preference; if policy cannot decide,
   return `needs_agent`.
3. Run `pay-quote` with the signal, realm, and idempotency seed. Stop when the
   quote is missing amount, currency, counterparty, operation, runtime path, or
   stable idempotency material.
4. Run `pay-reserve` with the quote and parent authority. The child authority
   must be a subset of the parent grant and must not broaden amount, currency,
   operation, counterparty, realm, period, runtime path, or capability.
5. If approval is required, pause at the spend gate and record the operator
   decision in the receipt. A denied or missing approval prevents fulfillment.
6. Run `pay-fulfill-rail` for the selected runtime path. Pass the payment
   challenge, reserved authority, spend capability ref, rail profile ref,
   idempotency packet, and quote packet.
7. Redact secret-bearing rail material. The receipt may contain proof refs,
   provider event refs, credential refs, hashes, and redaction notes; it must not
   contain raw funding material.
8. If fulfillment is ambiguous, return a recovery status and require
   `pay-recover` before any retry. If fulfillment is proven, seal the spend
   receipt before reporting success.

## Runtime paths

| Path | Use when | Required proof/evidence | Secret handling |
|---|---|---|---|
| `mock` | Deterministic local fixtures, CI, and docs. | Mock proof ref, amount, currency, counterparty, idempotency key. | No real funding material; still redact rail session material. |
| `x402` | A paid resource returns an x402-compatible challenge. | x402 payment proof ref, facilitator or receipt proof ref when available, challenge id, idempotency key. | Do not print wallet private keys, bearer tokens, or raw payment payloads. |
| `mpp` | An MPP profile is configured for the selected counterparty. | MPP settlement proof ref, profile ref, amount, currency, idempotency key. | Treat profile/session material as secret; output refs only. |
| `stripe-spt` | An explicit test profile is selected locally, or a hosted Stripe payment provider owns live credential custody. | Stripe charge id, payment intent id when present, provider event id, scoped SPT ref, idempotency key. | The local adapter refuses live profiles; never accept or emit Stripe secret keys, webhook secrets, card data, PANs, or unrestricted tokens. |

Future paths such as CDP must fit this table before they become runnable: named
authority bounds, scoped credential reference, verifier evidence, redaction
rules, idempotency behavior, and recovery behavior.

## Edge cases and stop conditions

- **Missing or ambiguous runtime path:** return `needs_agent`; do not guess a
  rail from available credentials.
- **Quote drift:** stop when the challenge, amount, currency, operation,
  counterparty, or runtime path changes after quote.
- **Parent grant too broad or too narrow:** reserve only a child subset. If the
  child cannot cover the quoted spend without widening, return `needs_agent`.
- **Approval denied or absent:** do not call the rail runner.
- **Raw credential material appears in input:** refuse or redact and return
  `needs_agent`; the rail runner accepts scoped references only.
- **Ambiguous rail response:** do not retry under a new idempotency key. Return
  recovery-required evidence.
- **Proofless success claim:** return `escalated`; a paid action cannot be
  marked successful without rail proof and a sealed receipt.
- **Fixture path used in production:** refuse unless the realm is explicitly
  `local` or `test`.

## Output schema (`payment_execution`)

```yaml
decision: sealed | denied | needs_agent | escalated
runtime_path: mock | x402 | mpp | stripe-spt
payment_quote_packet:
  payment_quote: object
  requested_payment_authority: object
  challenge_evidence: object | null
payment_reservation_packet:
  payment_decision: object
  reserved_payment_authority: object
  spend_capability_ref: object
  idempotency: object
payment_admission: object | null
payment_approval:
  approved: boolean
  gate_id: string
  decided_by: string | null
effect_evidence_packet:
  rail_result: object
  rail_proof: object
  credential_envelope: object
  redactions: [string]
  recovery_hint: object
sealed_receipt_ref: string | null
open_questions: [string]
```

A `sealed` decision requires a selected runtime path, subset reservation proof,
approved gate when required, rail proof, redaction notes for secret-bearing
fields, and a sealed receipt ref.

## Worked example

An x402-compatible paid search endpoint returns a challenge for `1.25 USD`,
counterparty `merchant:demo`, and operation `search.paid`. The parent grant
allows `payment` commits up to `1.25 USD` for that counterparty in realm `test`.
`spend` quotes the challenge, reserves a child authority with the same amount,
currency, operation, counterparty, and path `x402`, records the approval gate,
fulfills through `pay-fulfill-rail` runner `x402`, redacts rail session
material, and seals a receipt containing the x402 proof ref and idempotency key.
The result is `decision: sealed`.

If the same endpoint changes the amount after quote, the skill returns
`decision: needs_agent` or `escalated` depending on where drift is detected. It
does not silently re-quote and spend under the old approval.

## Inputs

- `payment_signal` (required): payment-required signal or challenge.
- `parent_payment_authority` (required): parent payment authority term or
  authority reference.
- `rail_profile_ref` (required): configured runtime-path profile reference.
- `payment_admission` (optional): hosted payment admission token and settlement
  identity. When present, it must be passed unchanged to the rail fulfillment
  stage so the sealed supervisor evidence can prove hosted settlement identity.
- `realm` (optional): authority realm such as `local`, `test`, or `prod`.
- `spend_policy` (optional): policy limits and approval thresholds.
- `approval_context` (optional): prior approval evidence.
- `idempotency_seed` (optional): stable idempotency material.
