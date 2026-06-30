---
name: data-subject-request
version: 0.1.0
description: Judge data subject requests against trusted identity proof, jurisdiction policy, and bounded scope, then emit a durable data-store verdict and a gated handoff.
source:
  type: cli-tool
  command: node
  args:
    - run.mjs
links:
  source: https://github.com/iwannabefree00/runx/tree/data-subject-request-skill/skills/data-subject-request
runx:
  category: business-ops
---

# Data Subject Request

`data-subject-request` decides whether a data subject request is eligible under
a supplied jurisdiction policy. It reads a request packet, trusted requestor
proof, scope bounds, and a pinned data-store binding, then emits a typed
`decision` plus a durable verdict-recording `append_event` packet.

The skill is intentionally judgment-only. It never deletes data, exports data,
sends a response, mints authority, or wraps its answer in an
`operational_proposal`. The output is data for downstream governed runs.

## Inputs

- `request_packet`: `{ type, subject_id, scope, request_id }`.
- `requestor_proof`: `{ identity_provider, verified_at, assertion, requestor_ref }`.
- `policy`: `{ jurisdiction, lawful_bases, scope_bounds, trusted_identity_providers, policy_id }`.
- `data_source_ref`: logical binding for `registry:runx/data-store@0.1.2`.
- `store_id`: pinned data-store id.
- `expected_version`: optional CAS version used by the verdict append.

## Outputs

- `decision`: `{ eligible, reason }` plus jurisdiction and lawful-basis detail.
- `handoff`: only when eligible. For erasure it names a bounded
  `subject.erasure_tombstone` path; for export it names the bounded
  `read_projection -> redact-pii -> send-as` path.
- `escalation`: human approval lane for untrusted identity, missing proof, or
  disputed / out-of-bounds scope.
- `data_store`: the durable seam:
  `read_projection -> append_event(idempotency_key, expected_version)` under
  `registry:runx/data-store@0.1.2`, keyed by the subject request entity.
- `evidence`: jurisdiction reason, identity assertion digest, scope bounds,
  aggregate id, idempotency key, refusal reason, and no-side-effect guarantees.

## Decision rules

1. Refuse requestors whose `identity_provider` is not in
   `policy.trusted_identity_providers`, whose proof has no `verified_at`, or
   whose assertion digest is missing.
2. Refuse any requested scope outside `policy.scope_bounds`.
3. Refuse request types without an explicit lawful basis in
   `policy.lawful_bases`.
4. For eligible erasure requests, emit a bounded handoff for a downstream
   governed data-store append of a `subject.erasure` tombstone. There is no
   direct delete operation.
5. For eligible export requests, emit a bounded handoff for a downstream
   governed `read_projection`, `redact-pii`, and `send-as` sequence under human
   approval.
6. Always record the decision as a request-verdict event using an ungated CAS
   append_event packet so the request remains decided across turns.

## Data-store seam

The request state is held in `registry:runx/data-store@0.1.2`:

1. `read_projection` for
   `aggregate_id = subject-request:{subject_id}:{request_id}`.
2. Decide against requestor proof, jurisdiction, lawful basis, and scope bounds.
3. `append_event` with the supplied `expected_version` and an idempotency key
   derived from subject, request id, request type, scope, and decision.

The append records only the verdict, scope, lawful basis, and non-secret proof
digest. It does not contain raw private data or credentials.

## Downstream handoff

Eligible decisions are consumed by separate governed runs:

- Erasure: a downstream operator appends a `subject.erasure` tombstone via
  data-store under approval.
- Export: a downstream operator runs `read_projection`, `redact-pii`, and
  `send-as` under approval.

This skill fires no rail itself. Ambiguous identity or disputed scope is routed
to the `human_privacy_approval` lane.

## Example

A verified EU-GDPR erasure request for `profile` and
`marketing_preferences` is eligible, records the verdict, and emits a bounded
erasure handoff. An export request from an untrusted email-link proof that also
asks for out-of-bounds `billing_history` is refused, records the refusal, and
emits no handoff.

