---
name: data-subject-request
version: 0.1.0
description: Decide a bounded data subject request, record the verdict through a governed data-store append_event, and hand off eligible erasure/export work without executing it.
source:
  type: cli-tool
  command: node
  args:
    - run.mjs
links:
  source: https://github.com/luismireles12/runx/tree/feat/data-subject-request/skills/data-subject-request
runx:
  category: data
---

# Data Subject Request

`data-subject-request` evaluates a bounded privacy request such as erasure or
export. It verifies that the requestor proof is present, checks the requested
data classes against the declared policy scope, records the decision through a
governed data-store transition, and returns a handoff packet only when the
request is eligible.

The skill does not erase, export, email, notify, or fire any operational rail.
Downstream processors consume the handoff under their own approval and receipt
gates.

## Inputs

- `request_packet`: object with `type`, `subject_id`, and `scope`.
- `requestor_proof`: object with `identity_provider`, `verified_at`, and
  `assertion`.
- `policy`: object with `jurisdiction`, `lawful_bases`, and `scope_bounds`.
- `data_source_ref`: logical source binding for `registry:runx/data-store`.
- `store_id`: pinned deterministic fixture store id for harness evidence.
- `aggregate_id`: subject request aggregate id.
- `expected_version`: optimistic-concurrency version for the verdict event.
- `idempotency_key`: stable retry key for the verdict event.

## Outputs

- `decision`: `{ eligible, reason }`.
- `handoff`: present only when `decision.eligible` is true. It contains a
  bounded path, subject id, data classes, and scopes for a downstream erasure or
  export worker.
- `escalation`: review notes and non-execution constraints.
- `data_store`: `read_projection` and `append_event` evidence shape including
  data source, store id, aggregate id, expected version, idempotency key, and
  verdict event.
- `evidence`: jurisdiction, lawful-basis verdicts, proof digest, scope bounds,
  refused reason if any, and harness-readable receipt notes.

## Decision rules

1. Refuse when `request_packet.type` is not `erasure` or `export`.
2. Refuse when `subject_id` or requested `scope` is missing.
3. Refuse when requestor identity is not verified with a provider, timestamp,
   and assertion.
4. Refuse when any requested class is outside `policy.scope_bounds`.
5. Refuse when any requested class lacks a declared lawful basis.
6. Seal an eligible decision only after producing an appendable verdict event
   with `expected_version` and `idempotency_key`.

## Data-store shape

This skill composes with `registry:runx/data-store@0.1.2` and uses the
following logical sequence:

1. `read_projection` for the subject request aggregate.
2. `decide` the lawful-basis and scope verdict.
3. `append_event` with optimistic concurrency and idempotency to record the
   verdict.

The emitted event never contains raw personal data. It records the request type,
subject id, jurisdiction, eligible flag, reason, requested scopes, scope bounds,
lawful-basis verdict, requestor proof digest, and downstream handoff path when
eligible.

## Example

A verified GDPR erasure request for `profile` and `marketing_events` is eligible
when both classes are inside `scope_bounds` and both have declared lawful bases.
The output includes a bounded handoff path such as
`handoff/dsr/sub_123/erasure.json` and a verdict event ready for `append_event`.

An unverified requestor or a request for a class outside policy bounds is refused
deterministically. The refusal names the jurisdiction and the lawful-basis or
scope reason and produces no handoff.
