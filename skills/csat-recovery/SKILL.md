---
name: csat-recovery
description: Turn a detractor signal into a bounded receipt-linked recovery decision, a governed send plan, and compare-and-set recovery state without performing a live act.
runx:
  category: support
---

# CSAT Recovery

`csat-recovery` is the live-save counterpart to triage and churn analysis. It
reads a detractor signal and prior recovery state, chooses one bounded recovery
play, and records the decision. The result is data for downstream governed
runners. This skill never mints authority, moves money, refunds, credits, or
sends a message.

The bounty contract names `registry:runx/data-store@0.1.2`. That historical
registry alias now returns 404. The executable graph pins the current signed
first-party replacement, `registry:runx/data-store@sha-567d29ed2d9a`, whose
profile exposes the required `read_projection` and `append_event` runners.

## Execution graph

1. Read the recovery projection with `read_projection`, keyed by
   `customer_context.id` and a pinned `store_id`.
2. Judge the recovery request against the sealed charge, remaining refundable
   amount, monthly policy limit, and prior recoveries.
3. Emit one typed `recovery_decision` as data.
4. Append a redacted decision event with an ungated, idempotent compare-and-set
   `append_event(idempotency_key, expected_version)`.

## Typed inputs

```yaml
detractor_signal:
  score: number
  reason: string
  timestamp: RFC3339 timestamp
customer_context:
  id: string
  ltv: integer
  timezone: IANA timezone
recovery_policy:
  monthly_credit_limit: integer
  plays: [message, credit, escalate]
  message_templates: object
recovery_request:
  amount_minor: integer
  currency: string
  counterparty: string
  scopes: [string]
charge_receipt:
  sealed: true
  original_receipt_ref: string
  amount_minor: integer
  remaining_refundable_minor: integer
  currency: string
  counterparty: string
prior_recovery_ref: string | null
```

`charge_receipt` is mandatory when `chosen_play` is `credit`. The receipt must
be sealed and linkable to the request's currency and counterparty.

## Typed output

```yaml
recovery_decision:
  chosen_play: message | credit | escalate
  reason: string
  credit_ceiling:
    type: AttenuationRequest
    amount_minor: integer
    currency: string
    counterparty: string
    original_receipt_ref: string
    scopes: [string]
  send_plan:
    principal: string
    audience: string
    content_template_id: string
    content_digest: sha256:string
  escalation:
    required: boolean
    lane: string
    reason: string | null
  remaining_monthly_credit_after_minor: integer
  expected_version: integer
  idempotency_key: string
  state_event: object
```

`credit_ceiling` is emitted only for a credit play. It is an
`AttenuationRequest` ceiling, not minted authority and not a settled credit. A
downstream C3 spend/refund accepting runner must independently mint, reserve,
settle, and seal any approved credit against `original_receipt_ref`.

`send_plan` is dispatch-by-naming. It identifies the principal, audience,
template, and digest for a separate governed `send-as` run. It does not claim a
message was sent.

## Refusal and escalation rules

The decision cannot emit a credit ceiling when:

- customer identity is missing;
- the charge receipt is missing, unsealed, or unlinkable;
- currency or counterparty does not match;
- requested amount exceeds the original charge;
- requested amount exceeds `remaining_refundable_minor`;
- requested amount exceeds the remaining monthly limit after prior recoveries;
- scopes, policy limits, or prior state are ambiguous.

Each unsafe case selects `escalate`, sets `credit_ceiling: null`, and names the
human approval lane and reason. The skill never invents proof or authority.

## Harness

- `sealed-billing-error-credit-recovery` proves a sealed overcharge can yield
  `chosen_play: credit`, a bounded receipt-linked `AttenuationRequest`, a
  digest-bound send plan, a remaining monthly balance, and a CAS state append.
- `stop-credit-without-sealed-charge` requests credit without a linkable sealed
  receipt and intentionally omits `caller.answers` for the escalation agent-task
  sub-step. The graph stops at `needs_agent` before emitting a money ceiling or
  appending state.

The reproducible fixture inputs live under `fixtures/`.

```bash
runx --version
runx harness ./skills/csat-recovery --json
```

## Publish, install, run, verify

```bash
runx login --provider github --for publish
runx registry publish ./skills/csat-recovery/SKILL.md --registry https://api.runx.ai
runx add rohitmulani63-ops/csat-recovery@0.1.0 --registry https://api.runx.ai
runx skill rohitmulani63-ops/csat-recovery@0.1.0 --registry https://api.runx.ai --json
runx verify --receipt <receipt.json> --json
```

For a real dogfood run, supply the typed input object shown above. Record the
post-publish skill receipt, not an inline harness fixture receipt.
