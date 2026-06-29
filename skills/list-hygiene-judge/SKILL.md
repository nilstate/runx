---
name: list-hygiene-judge
description: Judge contact list hygiene from data-store evidence and record a consent-state transition without sending.
source:
  type: cli-tool
  command: node
  args:
    - run.mjs
  timeout_seconds: 30
  sandbox:
    profile: readonly
    cwd_policy: skill-directory
    require_enforcement: false
inputs:
  data_source_ref:
    type: string
    required: true
    description: Logical data source that owns the contact event stream.
  resource:
    type: string
    required: true
    description: Contact consent event resource.
  aggregate_id:
    type: string
    required: true
    description: Contact entity key.
  expected_version:
    type: number
    required: true
    description: Contact stream version expected before the CAS append.
  idempotency_key:
    type: string
    required: true
    description: Stable retry key for the consent-state transition.
  engagement_history:
    type: json
    required: true
    description: Opens, clicks, hard bounces, and recency evidence read from the contact projection.
  bounce_policy:
    type: json
    required: true
    description: Hard-bounce and engagement-decay thresholds.
  current_consent_state:
    type: json
    required: true
    description: Current consent projection, including version and unsubscribe marker.
runx:
  category: compliance
  input_resolution:
    required:
      - data_source_ref
      - resource
      - aggregate_id
      - expected_version
      - idempotency_key
      - engagement_history
      - bounce_policy
      - current_consent_state
---

# List Hygiene Judge

`list-hygiene-judge` sits between engagement decay and durable consent-state
transitions. It reads a contact projection from a declared data-store resource,
judges whether the contact should be re-permissioned, suppressed, verified, or
escalated, and emits the exact append event that records the transition.

The skill never sends a message. A downstream governed `send-as` run is the only
lane that may deliver a campaign, and it must read the recorded consent state at
send time.

## Contract

- Inputs are `data_source_ref`, `resource`, `aggregate_id`,
  `expected_version`, `idempotency_key`, `engagement_history`,
  `bounce_policy`, and `current_consent_state`.
- Output is a `runx.list_hygiene_judgment.v1` packet with:
  - `decision{state,reason}`
  - a `data_store.read_projection` evidence block
  - one `data_store.append_event` evidence block when a transition is safe
  - a `recorded_transition` readback projection when an append is emitted
  - a `stop` block and no append when evidence is missing, stale, ambiguous, or
    blocked by an active unsubscribe marker.

## Decision rules

- Hard-bounce evidence (`hard_bounces > 0`) suppresses the contact.
- Engagement decay beyond `bounce_policy.decay_threshold_days` re-permissions a
  contact only when there is no active unsubscribe marker.
- Contacts with fresh engagement remain in `verify` state.
- Missing metrics, stale `expected_version`, ambiguous bounce recovery, or an
  active unsubscribe marker stop before any append and escalate to a human lane.

## State and authority boundary

The state transition is modeled as an ungated compare-and-set append through
`registry:runx/data-store@0.1.2`: read projection, decide, append with
`idempotency_key` and `expected_version`, then read back the recorded version.
The runner emits this data-store operation evidence as plain data for the
receipt; it does not send, mint, grant authority, or create an
`operational_proposal` envelope.

## Verification

Run the local harness:

```bash
runx harness ./skills/list-hygiene-judge
```

Run a dogfood decision:

```bash
runx skill ./skills/list-hygiene-judge --json \
  -i data_source_ref=local://runx/list-hygiene/demo \
  -i resource=contact_consent_events \
  -i aggregate_id=contact:demo-001 \
  --input-json expected_version=3 \
  -i idempotency_key=contact:demo-001:list-hygiene:2026-06-29 \
  --input-json engagement_history='{"opens_count":0,"clicks_count":0,"hard_bounces":0,"recency_days":120}' \
  --input-json bounce_policy='{"hard_bounce_action":"suppress","decay_threshold_days":90}' \
  --input-json current_consent_state='{"state":"subscribed","version":3,"unsubscribe_marker":false}'
```
