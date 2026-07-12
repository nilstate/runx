---
name: revenue-leakage-auditor
description: Audit one account-period for revenue leakage by comparing usage against billing, emitting only bounded adjustment ceilings as data for eligible under-billed accounts.
runx:
  category: business
---

# Revenue Leakage Auditor

`revenue-leakage-auditor` is a finance review skill. It reads one account's
usage record, billing history, discount policy, threshold, and parent adjustment
bounds, then decides whether an under-billing gap is real enough to recover. It
does not charge a customer, refund money, mint authority, or settle an
adjustment.

The output is a typed review decision plus zero or more bounded
`AttenuationRequest` ceilings carried as data. A downstream driver may hand a
ceiling to the core spend/refund accepting runner, which alone owns child grant
minting, reservation, settlement, and receipt sealing. This skill only records
the review and the bounded data a later governed runner may consume.

## What This Skill Does

1. Reads durable per-account reconciliation state through
   `registry:runx/data-store@0.1.2`.
2. Matches `usage_records.account_id` to `billing_history.account_id` for the
   same billing period.
3. Computes the billed-vs-usage gap only from supplied records.
4. Applies `charge_threshold_pct` before treating a gap as leakage.
5. Drops accounts excluded by `discount_policy.excluded_accounts`.
6. Drops gaps covered by `discount_policy.known_discounts`.
7. Emits one bounded ceiling per eligible under-billed account, clamped to
   `parent_adjustment_bounds`.
8. Appends a reconciliation event with a CAS `append_event` using a stable
   idempotency key keyed by account and period.

## Inputs

```yaml
usage_records:
  account_id: string
  usage_amount: number
  period: string
billing_history:
  account_id: string
  billed_amount: number
  period: string
discount_policy:
  excluded_accounts: [string]
  known_discounts: array
charge_threshold_pct: number
parent_adjustment_bounds: object
```

The usage and billing records may include `currency` and `evidence_ref`. When an
evidence ref is absent, the reviewer derives a stable reference from
`account_id` and `period` rather than inventing an external source.

## Output

```yaml
decision:
  leakage_found: boolean
  reason: string
ceilings:
  - schema: runx.attenuation_request.v1
    form: data
    account_id: string
    amount:
      amount: number
      currency: string
    currency: string
    scopes: [spend.reserve, spend.settle, receipt.seal]
    usage_evidence_ref: string
    billing_evidence_ref: string
    idempotency_key: string
    downstream_runner: registry:runx/spend@0.1.1
escalation:
  required: boolean
  lane: human_approval
  reason: string
data_store:
  package_ref: registry:runx/data-store@0.1.2
  read_projection: object
  append_event: object
observations: object
```

`ceilings` is empty when no leakage is found, the account is excluded, a known
discount covers the gap, records are incomplete, or the gap stays inside the
threshold. A ceiling is a review artifact only; it is not a reservation, subset
proof, mint, settlement, or proposal envelope.

## Decision Rules

- **Leakage found** only when account and period match, usage and billing amounts
  are complete, currency is compatible, the account is not excluded, no known
  discount covers the gap, and the under-billed percentage exceeds
  `charge_threshold_pct`.
- **No change** when billing is at or above usage, the gap is within threshold,
  or a known discount covers the difference.
- **Needs agent** when account, period, usage amount, billed amount, currency,
  threshold, or parent bounds are missing or contradictory.
- **Human approval lane** is named whenever a downstream runner would consume a
  ceiling. The approval happens outside this review skill.

## Data-Store Handoff

This skill carries the `registry:runx/data-store@0.1.2` handoff contract in the
review packet and executes the same governed data operation envelope through
`data.source` graph steps.

- `read_projection` reads `resource: account_reconciliations` for the account
  aggregate.
- `append_event` writes either `revenue_leakage.detected` or
  `revenue_leakage.no_change`.
- `idempotency_key` is keyed by account id, period, and review outcome.
- `expected_version` is supplied by the review packet so CAS failures are
  visible instead of overwritten.

The event is evidence of the review. It is not authority to charge, refund, or
settle anything.

## Adjustment Handoff

Each ceiling is a typed value, not an effect. A downstream driver must:

- pass the ceiling to the core spend/refund accepting runner;
- mint any attenuated child grant there, never here;
- reserve, settle, and seal under the accepting runner's charter;
- fail closed when a request exceeds the ceiling amount, currency, or scopes;
  and
- require human approval before consuming the ceiling.

## Stop Conditions

- `account_mismatch`: usage and billing records name different accounts.
- `period_mismatch`: usage and billing records cover different periods.
- `missing_usage_evidence`: usage amount is absent or not numeric.
- `missing_billing_evidence`: billed amount is absent or not numeric.
- `currency_mismatch`: usage, billing, or parent bounds currencies differ.
- `excluded_account`: discount policy excludes the account.
- `known_discount`: discount policy covers the apparent gap.
- `below_threshold`: the under-billed percentage is at or below the threshold.
- `bounds_missing`: parent adjustment bounds cannot clamp the ceiling.

## Verification Notes

The harness carries exactly two cases:

- `revenue-leakage-auditor-underbilling-ceiling` seals a leakage review with a
  bounded `AttenuationRequest` ceiling as data and a CAS append event.
- `revenue-leakage-auditor-stop-needs-agent` omits caller answers so the review
  blocks at `needs_agent` with no ceiling, no mint, no settlement, and no append
  event.

The dogfood run should execute the published package after install and verify
the receipt from that post-publish run, not a local harness fixture receipt.
