---
name: vendor-risk-review
version: 0.1.0
description: Review vendor contract terms against a supplied policy, refuse hard risk violations, conditionally approve recoverable gaps, and emit a governed risk-record append_event packet.
source:
  type: cli-tool
  command: node
  args:
    - run.mjs
links:
  source: https://github.com/iwannabefree00/runx/tree/vendor-risk-review/skills/vendor-risk-review
runx:
  category: business-ops
---

# Vendor Risk Review

`vendor-risk-review` evaluates a vendor contract against an explicit vendor-risk
policy. It returns a typed decision and, whenever the vendor and policy packet
are complete, prepares a durable `append_event` risk record for
`registry:runx/data-store@0.1.2`.

The skill never sends stakeholder notifications, never reads receipt-ledger
state, and never executes a downstream procurement action. Notification is a
separate governed send-as run after human approval.

## Inputs

- `contract_text`: vendor contract text.
- `vendor_context`: object with `vendor_ref`, `history`, and `industry`.
- `policy`: object with `required_sla_terms`, `max_liability`,
  `data_handling_floor`, `termination_window`, `policy_id`, and `created_at`.
- `data_source_ref`: logical binding for the governed data-store dependency.
- `store_id`: pinned store id used for deterministic harness and dogfood runs.

## Outputs

- `decision`: `{ approved, reason, conditions[], rejected }`.
- `risk_record`: appendable event payload or `null` when the skill must stop
  before write.
- `data_store`: the intended `read_projection` and `append_event` sequence,
  including `store_id`, `aggregate_id`, `expected_version`, and
  `idempotency_key`.
- `escalation`: human-review lane when the vendor is ambiguous, policy is
  incomplete, or the prior projection is unreadable.
- `evidence`: digests, rules applied, hard-blocking findings, recoverable
  conditions, and no-side-effect guarantees.

## Decision rules

1. Stop before write when `vendor_ref` is missing, the policy is incomplete, or
   prior state cannot be read from `vendor_context.history`.
2. Reject when liability is unbounded, uncapped, unlimited, or materially above
   `policy.max_liability`.
3. Reject when the contract's data-handling posture is below
   `policy.data_handling_floor`.
4. Approve with conditions for recoverable SLA or termination gaps. Conditions
   name the missing policy term without inventing requirements.
5. Append a risk-record event whenever the vendor and policy are complete,
   including rejection decisions. Missing-policy and ambiguous-vendor paths emit
   no write.

## Data-store seam

The handoff seam is an ungated compare-and-set write:

1. `read_projection` for the vendor aggregate.
2. Decide against the supplied policy and contract text.
3. `append_event` through `registry:runx/data-store@0.1.2` with
   `aggregate_id = vendor_context.vendor_ref`, `expected_version` from the prior
   projection, and an `idempotency_key` keyed on
   `vendor_ref + policy_id + decision`.

The emitted event records `vendor_ref`, `decision`, `conditions`, `policy_id`,
and `created_at`, plus a contract digest and non-sensitive findings. It does not
contain secrets, raw credentials, or private customer data.

## Example

A vendor with SOC2 data handling and capped liability but missing uptime-credit
language is approved with conditions. A vendor asking for unlimited liability is
rejected and still recorded as a durable risk decision. A request with an
ambiguous vendor or incomplete policy stops before write and escalates to the
human approval lane.
