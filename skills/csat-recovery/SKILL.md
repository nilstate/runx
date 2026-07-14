---
name: csat-recovery
description: Decide a bounded recovery play for a CSAT detractor without sending a message or moving money.
links:
  source: https://github.com/runxhq/runx/pull/308
runx:
  category: support
---

# CSAT Detractor Recovery

Use this graph when a detractor signal requires a bounded apology, linked service
credit, or human escalation. It is a judgment skill: it performs no refund, no
send, no mint, no reservation, and no settlement.

## Contract

Inputs are `detractor_signal{score,reason,timestamp}`,
`customer_context{id,ltv,timezone}`,
`recovery_policy{monthly_credit_limit,plays,message_templates}`,
`recovery_request{amount_minor,currency,counterparty,scopes}`, optional
`prior_recovery_ref`, `recovery_month`, `data_source_ref`, `store_id`, a stable
`idempotency_key`, and `charge_receipt{original_receipt_ref,amount_minor,
remaining_refundable_minor}` whenever credit is considered. The audit-only
`prior_recovery_ref` never supplies the numeric monthly total.

Output is `recovery_decision{chosen_play,reason,credit_ceiling,send_plan,
escalation}` plus `remaining_monthly_credit`. `credit_ceiling` is present only
for `chosen_play: credit` and is a bounded `AttenuationRequest` carried as data:
`{amount_minor,currency,counterparty,original_receipt_ref,scopes}`. It is never a
mint and never `runx.operational_proposal.v1`.

`send_plan{principal,audience,content_template_id,content_digest}` names a future
governed send. It does not dispatch a message. The content digest must be derived
from the selected policy template and bounded customer context.

## Decision rules

1. Refuse credit without an exact sealed `original_receipt_ref`.
2. Cap credit at the lesser of the request, the charge's
   `remaining_refundable_minor`, and the remaining monthly policy balance after
   prior recoveries.
3. Require matching currency, customer counterparty, and recovery scope.
4. Never invent a charge link, counterparty, message template, or policy limit.
5. Route missing customer identity, unclear prior recovery state, over-ceiling
   requests, and currency mismatches to the blocking human lane with no ceiling.
6. Record the chosen play, reason, remaining monthly credit, content digest, and
   any bounded ceiling in the sealed decision receipt.

## Durable state seam

The graph composes the `registry:runx/data-store@0.1.2` operation contract and
ships the `data.local` development adapter used by its public harness. Before
judgment, `read-recovery-state` performs `read_projection` against
`recovery_events`, keyed by `customer_context.id` and filtered by
`recovery_month`. The projection exposes its stream `version` and the folded
`monthly_recovery_total_minor`; the reviewer must deduct that stored total from
the policy limit and must not infer a number from `prior_recovery_ref`.

After the decision and explicit human confirmation, `append-recovery-event`
performs an ungated CAS `append_event`: `expected_version` comes directly from
the earlier projection, the caller supplies a stable `idempotency_key`, and the
recorded event comes from the grounded decision packet. A final readback proves
the aggregate version and folded monthly total. A conflict stops rather than
overwriting a concurrent recovery. The audit ledger is referenced only by
receipt id-stub and is never used as a customer-keyed state read.

## Downstream handoff

For a credit play, a downstream driver hands the ceiling to the core
spend/refund accepting runner (C3). C3 may attenuate it further, then mints,
reserves, settles, and seals the credit against `original_receipt_ref`; it cannot
widen the ceiling. For an apology, a driver or operator starts a separate
governed send-as run by naming `send_plan`. If this graph denies, escalates, or
remains unconfirmed, there is no ceiling or send authority to consume.
