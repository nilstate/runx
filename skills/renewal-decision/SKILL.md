---
name: renewal-decision
description: Decide whether a vendor renewal should renew, renegotiate, or cancel, emitting only a bounded spend ceiling for approved renew paths.
runx:
  category: business
---

# Renewal Decision

`renewal-decision` is a procurement judgment skill. It reads a vendor contract,
usage and spend actuals, a renewal offer, and a procurement policy, then decides
whether to renew, renegotiate, or cancel. It does not move money, mint authority,
or send notice to the vendor.

The output is a typed renewal decision plus an optional bounded
`AttenuationRequest` ceiling carried as data. A downstream driver may hand that
ceiling to the core spend/refund accepting runner, which owns child grant
minting, reservation, settlement, and receipt sealing. Vendor notice is likewise
a separate governed send-as run named by the downstream driver.

## What This Skill Does

1. Reads the current vendor projection through `registry:runx/data-store@0.1.2`.
2. Matches the renewal offer to `vendor_contract.vendor_id`.
3. Computes usage alignment from supplied `usage_actuals`; it never invents
   missing units, cost, or spend.
4. Applies `procurement_policy.max_renewal_pct` to
   `vendor_contract.contract_value`.
5. Emits `decision.action` as `renew`, `renegotiate`, or `cancel`.
6. Emits a bounded ceiling only when the action is `renew` and the offer is at
   or beneath the policy cap.
7. Appends the decision event with a CAS `append_event` using a stable
   idempotency key keyed by `vendor_id`.

## Inputs

```yaml
vendor_contract:
  vendor_id: string
  contract_ref: string
  current_terms: object
  contract_value:
    amount: number
    currency: string
  expiry: string
usage_actuals:
  periods: array
  units_consumed: number
  cost_per_unit: number
renewal_offer:
  amount:
    amount: number
    currency: string
  currency: string
  terms: object
  expiry: string
procurement_policy:
  min_usage_units: number
  max_renewal_pct: number
  approval_threshold:
    amount: number
    currency: string
```

## Output

```yaml
decision:
  action: renew | renegotiate | cancel
  reason: string
  confidence: low | medium | high
bounded_ceiling:
  schema: runx.attenuation_request.v1
  form: data
  amount:
    amount: number
    currency: string
  scopes: [spend.reserve, spend.settle, receipt.seal]
  counterparty: string
  idempotency_key: string
  downstream_runner: registry:runx/spend@0.1.1
escalation_packet:
  approval_required: boolean
  lane: human_approval
  reason: string
data_store:
  package_ref: registry:runx/data-store@0.1.2
  read_projection: object
  append_event: object
observations: object
```

`bounded_ceiling` is `null` when the decision is `renegotiate` or `cancel`.
The ceiling is also `null` when the vendor cannot be matched, usage is below
policy minimum, or the offer exceeds the allowed renewal percentage.

## Decision Rules

- **Renew** only when the vendor matches, usage is at or above
  `min_usage_units`, the renewal amount is within
  `contract_value * (1 + max_renewal_pct / 100)`, and the offer currency matches
  the contract currency.
- **Renegotiate** when usage is healthy but price, terms, or currency exceed the
  policy bounds.
- **Cancel** when usage is below the minimum or the vendor cannot be matched to
  the contract.
- **Stop instead of guessing** when contract value, renewal amount, vendor
  identity, usage units, or policy cap is missing.

## Data-Store Handoff

This skill composes `registry:runx/data-store@0.1.2` through the graph:

- `read_projection` reads `resource: vendor_renewals` for the vendor aggregate.
- `append_event` writes a `renewal_decision.recorded` event.
- `idempotency_key` is keyed by `vendor_id`, renewal period, and decision.
- `expected_version` is supplied by the decision packet so CAS failures are
  visible instead of overwritten.

The event is evidence of the judgment, not authority to spend.

## Spend Handoff

The bounded ceiling is a data artifact, not an execution. A downstream driver
must:

- pass the ceiling to the core spend/refund accepting runner;
- mint the attenuated child grant there, never here;
- reserve, settle, and seal under the spend runner's charter;
- fail closed when the spend request exceeds the ceiling; and
- require the human approval lane before consuming the ceiling.

## Stop Conditions

- `vendor_mismatch`: the vendor identity cannot be tied to the contract.
- `usage_below_minimum`: supplied usage is below the policy minimum.
- `amount_over_cap`: the renewal offer exceeds the maximum renewal percentage.
- `currency_mismatch`: contract and offer currencies differ.
- `missing_actuals`: usage or spend evidence is incomplete.
- `missing_policy`: policy cap or minimum usage is absent.
- `needs_version`: the append event cannot declare an expected version.

## Verification Notes

The harness carries exactly two cases:

- `renewal-decision-renew-with-bounded-ceiling` seals a renew judgment with an
  `AttenuationRequest` ceiling and a CAS append event.
- `renewal-decision-stop-over-policy-cap` seals a cancel judgment with no
  ceiling when usage is low and the offer exceeds policy.

The dogfood run should execute the published package after install and verify
the receipt from that post-publish run, not a local harness fixture receipt.
