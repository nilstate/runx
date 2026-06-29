---
name: outreach-sequencer
description: Decide the next outreach touch from durable engagement state, append the decision event, and emit a handoff-only next-touch packet without sending.
runx:
  category: ops
---

# Outreach Sequencer

Outreach Sequencer decides whether one contact in one sequence should receive
the next touch. It reads the sequence definition and the contact's engagement
projection, stops immediately after a reply or unsubscribe, enforces
`min_days_apart`, appends one decision event through the data-store operation
shape, and emits a typed `runx.outreach.next_touch.v1` packet only when the next
touch is eligible.

This skill never sends. The packet names the downstream `send-as` run that a
driver or operator may issue under its own approval and preflight. Sequence
progress is durable state; egress is a separate governed consequence.

## What This Skill Does

1. **Validate sequence state.** Refuse to guess when the sequence definition,
   touch list, contact ref, aggregate id, idempotency key, or expected version
   is missing.
2. **Read durable engagement evidence.** Treat `prior_projection` as the
   data-store `read_projection` result for the sequence/contact aggregate. Every
   reply, unsubscribe, bounce, and prior sent touch used in a decision is
   recorded in the output as an `operation_result`.
3. **Stop on reply or unsubscribe.** If the engagement stream contains a reply
   or unsubscribe, seal with `decision.eligible: false`, reason `replied` or
   `unsubscribed`, no next-touch packet, and no append event.
4. **Enforce spacing.** If the prior sent touch is more recent than
   `rules.min_days_apart`, seal with `decision.eligible: false`,
   reason `too_soon`, no next-touch packet, and no append event.
5. **Append eligible decisions.** When eligible, append one
   `outreach.next_touch_selected` event via
   `append_event(idempotency_key, expected_version)` against
   `registry:runx/data-store@0.1.2` with the pinned `store_id` and
   `aggregate_id`.
6. **Emit a handoff packet.** The `runx.outreach.next_touch.v1` packet binds
   send class `outreach`, principal, channel, audience, content digest, touch
   index, and dispatch idempotency key. It is data only.

## Contract Boundaries

- **Inputs are typed.**
  - `sequence_definition`: `touches` and `rules`.
  - `aggregate_id`: sequence/contact entity key for state.
  - `contact_ref`: stable contact reference and audience binding.
  - `current_touch_index`: optional current index; defaults to the first
    unsent touch after prior projection.
  - `store_id`: pinned data-store id.
  - `idempotency_key`: append idempotency key.
  - `expected_version`: expected projection version.
- **State is data-store shaped.** The sequence is
  `read_projection -> decide -> append_event(idempotency_key, expected_version)`.
  The skill records operation-result evidence but does not depend on private
  data-store credentials.
- **Output is typed.** The artifact is `outreach_decision`, containing
  `decision`, `engagement_read`, optional `append_event`, optional
  `next_touch_packet`, and `escalation`.
- **No authority minting.** The skill does not mint authority, produce an
  operational proposal envelope, or call a provider.

## Refusals And Stops

- Missing sequence definition, empty touches, missing contact ref, missing
  aggregate id, missing idempotency key, or unreadable engagement state returns
  `decision.eligible: false` with reason `needs_human` or `needs_input` and no
  append.
- Reply and unsubscribe always stop the sequence and emit no packet.
- A prior touch inside `min_days_apart` stops with reason `too_soon`.
- A contact beyond the end of the sequence stops with reason
  `sequence_complete`.
- A bounce may advance the sequence only if the sequence policy declares
  `advance_on_bounce: true`; otherwise it stops with reason `bounced`.

## Quality Profile

- Purpose: decide one next outreach touch from durable engagement state.
- Audience: outreach operators, compliance reviewers, and downstream send
  drivers.
- Artifact contract: eligibility verdict, engagement operation-result evidence,
  data-store append operation-result, next touch packet, and stop reason.
- Evidence bar: every positive decision cites the engagement stream read, prior
  touch spacing, selected touch, append version movement, and dispatch key.
- Safety bar: no sends, no authority minting, and fail-closed stops after reply
  or unsubscribe.
- Stop conditions: missing state, reply, unsubscribe, too soon, bounce when
  bounce advancement is disallowed, or sequence complete.

## Output Schema

```yaml
outreach_decision:
  decision:
    eligible: boolean
    reason: next_touch | replied | unsubscribed | too_soon | bounced | sequence_complete | needs_human | needs_input
    current_touch_index: number
    next_touch_index: number | null
  engagement_read:
    store_id: string
    aggregate_id: string
    operation: read_projection
    operation_result:
      version: number
      events:
        - type: reply | unsubscribe | bounce | sent | decision
          at: string
          touch_index: number | null
  append_event:
    attempted: boolean
    operation_result:
      event_type: outreach.next_touch_selected | null
      before_version: number
      after_version: number | null
      idempotency_key: string
      expected_version: number
  next_touch_packet:
    packet_type: runx.outreach.next_touch.v1
    send_class: outreach
    principal: string
    channel: string
    audience:
      contact_ref: string
    content_digest: string
    dispatch_idempotency_key: string
    touch_index: number
  escalation:
    lane: human-approval | none
    reason: string
```

## Inputs

- `sequence_definition` (required): `touches` and `rules`.
- `aggregate_id` (required): sequence/contact aggregate id.
- `contact_ref` (required): stable contact reference.
- `current_touch_index` (optional): explicit next touch index.
- `store_id` (required): pinned data-store id.
- `idempotency_key` (required): append idempotency key.
- `expected_version` (required): expected read projection version.
- `prior_projection` (optional): data-store read projection, including version
  and engagement events.
