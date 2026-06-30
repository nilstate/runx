---
name: outreach-sequencer
description: Decide the next eligible outreach touch from durable engagement state, append the decision event, and emit a handoff-only send packet.
source:
  type: cli-tool
  command: node
  args:
    - run.mjs
runx:
  tags:
    - outreach
    - sequencing
    - data-store
links:
  composes:
    - registry:runx/data-store@0.1.2
    - send-as
---

# Outreach Sequencer

This skill reads a bounded outreach sequence definition and the contact's
durable engagement projection for one sequence/contact aggregate. It decides
whether the next touch is eligible, records the decision as an ungated
data-store append event, and emits a typed handoff packet for a downstream
governed `send-as` run.

## Inputs

- `sequence_definition`: object with `touches[]` and `rules`.
- `aggregate_id`: sequence/contact entity id used for data-store reads and
  appends.
- `contact_ref`: bounded contact reference with `principal`, `audience`, and
  optional `channel`.
- `current_touch_index`: optional number representing the last completed touch.
- `store_id`: pinned data-store id for outreach sequence state.
- `idempotency_key`: caller-provided idempotency key for the decision append.
- `expected_version`: CAS version read from the engagement projection.
- `engagement_projection`: bounded data-store read projection containing
  `operation_result`, `events[]`, and `version`.

## Outputs

The skill emits `runx.outreach.sequencer.v1`:

- `decision`: `{ eligible, reason }`.
- `append_event`: an ungated CAS append event shaped for
  `registry:runx/data-store@0.1.2`.
- `next_touch_packet`: present only when eligible. It has schema
  `runx.outreach.next_touch.v1` and binds `send_class`, `principal`, `channel`,
  `audience`, `content_digest`, and the dispatch `idempotency_key`.
- `escalation`: present when a missing sequence definition or unreadable state
  needs a human approval lane.
- `stop_state`: present when a reply, unsubscribe, or too-recent prior touch
  stops dispatch.

## Safety Boundaries

The skill does not send email, post messages, mint authority, or emit a proposal
envelope. The next-touch packet is a handoff only: a separate governed
downstream driver or operator must run `send-as` with its own preflight and
approval to deliver the touch. Sequence progress is committed only as an
ungated `append_event(idempotency_key, expected_version)` against the pinned
`store_id` and aggregate id.

The skill refuses to emit a touch packet after a reply or unsubscribe event,
refuses when the prior touch was sent less than `min_days_apart` ago, and never
invents an engagement event it cannot link to the supplied data-store
`operation_result`.

## Procedure

1. Validate the sequence definition, aggregate id, contact reference, store id,
   idempotency key, expected version, and engagement projection.
2. Read the supplied engagement projection for the sequence/contact aggregate.
3. Stop if a reply or unsubscribe event appears in the durable engagement
   stream.
4. Stop if the prior sent touch is inside the configured `min_days_apart`
   window.
5. Select the next touch after `current_touch_index`, or infer it from the
   latest sent event when not supplied.
6. Append an outreach decision event with CAS version movement.
7. Emit exactly one `runx.outreach.next_touch.v1` handoff packet when eligible.
