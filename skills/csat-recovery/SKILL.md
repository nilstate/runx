---
name: csat-recovery
description: Route a sealed CSAT detractor signal into a bounded, receipt-grounded recovery decision and persist the decision with compare-and-set state.
runx:
  category: support
---

# CSAT Recovery

`csat-recovery` turns a detractor signal into one governed recovery decision.
It reads the customer's prior recovery projection, selects a bounded play, and
records the decision with compare-and-set persistence. The skill emits data for
an operator or another governed lane to execute; it never sends a message or
moves money itself.

The bounty contract names `registry:runx/data-store@0.1.2`. That historical
registry alias now returns 404. The executable graph therefore pins the current
signed first-party replacement,
`registry:runx/data-store@sha-567d29ed2d9a`, whose materialized profile exposes
the required `read_projection` and `append_event` runners. Runx resolves it only
from the local registry; install or sync that package before execution because
graph runs never fetch remote dependency content implicitly.

## Use it when

- A sealed CSAT or NPS detractor signal needs a consistent recovery decision.
- Billing-error recovery needs a receipt-linked credit ceiling rather than an
  unbounded promise.
- Customer support needs a draft send plan plus an explicit escalation path.
- Recovery history must be loaded by customer id and updated without lost
  writes.

Do not use this skill to execute a refund, issue a credit, send a message, or
infer money authority from a complaint alone. Those effects belong in separate
governed skills after explicit approval.

## Graph

1. `read-state` calls `data-store.read_projection` using `customer_id` as the
   aggregate key and a caller-pinned `store_id`.
2. `decide` evaluates the detractor signal, customer context, policy, request,
   charge receipt, caller-provided history, and stored projection.
3. `append-state` calls `data-store.append_event` with the decision's
   `expected_version`, stable idempotency key, and redacted event.

The append is compare-and-set. A stale projection cannot silently overwrite a
newer recovery decision.

## Decision rules

The chosen play is exactly one of:

- `credit`: a data-only `AttenuationRequest` bounded by a sealed original charge.
- `replacement`: a non-monetary replacement plan subject to operator execution.
- `concierge`: a high-touch follow-up plan subject to operator execution.
- `escalate`: no safe automated recovery decision is available.

A money-related ceiling is refused when any of these conditions holds:

- The original charge receipt is missing or unsealed.
- Receipt customer, counterparty, or currency does not match the request/policy.
- The requested amount exceeds the original charge.
- The request exceeds the remaining monthly or per-action policy ceiling.
- Prior recovery or projection state is ambiguous.

In those cases the decision must use `status: needs_agent`,
`chosen_play: escalate`, and `credit_ceiling: null`. No money ceiling may be
invented.

## Inputs

| Input | Required | Meaning |
| --- | --- | --- |
| `data_source_ref` | yes | Logical durable data source binding. |
| `store_id` | yes | Pinned store owner for deterministic state. |
| `resource` | yes | Event stream/projection resource. |
| `customer_id` | yes | Projection partition key. |
| `detractor_signal` | yes | Sealed signal, score, source, and reason. |
| `customer_context` | yes | Minimal redacted context used for routing. |
| `recovery_policy` | yes | Allowed plays and bounded money policy. |
| `recovery_request` | yes | Requested play, amount, and reason. |
| `charge_receipt` | for money | Sealed original charge receipt. |
| `prior_recovery` | no | Caller-provided recovery summary. |

## Output

The `runx.csat.recovery_decision.v1` packet is data only:

```yaml
status: ready | needs_agent | refused
chosen_play: credit | replacement | concierge | escalate
rationale: string
credit_ceiling:
  type: AttenuationRequest
  resource: customer_credit
  amount_minor: integer
  currency: string
  original_receipt_ref: string
  counterparty: string
  constraints: object
send_plan:
  mode: draft_only
  channel: string
  template: string
  requires_operator_send: true
escalation:
  required: boolean
  reason: string | null
  queue: string | null
expected_version: integer
idempotency_key: string
state_event: object
```

For non-credit plays, `credit_ceiling` is `null`. A send plan is always a draft
and cannot claim that a customer was contacted.

## Harness coverage

- `sealed-billing-error-credit-recovery` proves a sealed duplicate charge can
  produce `chosen_play: credit` and a bounded `AttenuationRequest` linked to the
  original charge receipt, followed by a compare-and-set state append.
- `stop-credit-without-sealed-charge` omits a sealed charge and deliberately
  provides no caller answer to the escalation decision sub-step. The graph must
  stop at `needs_agent`; it cannot emit a credit ceiling or append a recovery
  decision.

Run locally:

```bash
runx harness ./skills/csat-recovery --json
```

After registry publication, install and dogfood the immutable package:

```bash
runx add rohitmulani63-ops/csat-recovery@0.1.0
runx skill rohitmulani63-ops/csat-recovery@0.1.0 --json
runx verify <receipt-ref> --json
```

The verified post-publish receipt, not a harness fixture receipt, is the delivery
receipt for Frantic evidence.
