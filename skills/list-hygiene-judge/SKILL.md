---
name: list-hygiene-judge
description: Judge contact list hygiene from data-store evidence and record one durable consent-state transition without sending.
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
    description: Hosted data-store reference that owns the contact projection and consent event stream.
  resource:
    type: string
    required: true
    description: Contact consent event resource in registry:runx/data-store@0.1.2.
  aggregate_id:
    type: string
    required: true
    description: Contact entity key used as the stream aggregate id.
  expected_version:
    type: number
    required: true
    description: Compare-and-set version expected before append_event.
  idempotency_key:
    type: string
    required: true
    description: Stable retry key for the consent-state transition.
  engagement_history:
    type: json
    required: true
    description: Evidence read from the contact projection: opens_count, clicks_count, hard_bounces, and recency_days.
  bounce_policy:
    type: json
    required: true
    description: Policy thresholds including hard_bounce_action and decay_threshold_days.
  current_consent_state:
    type: json
    required: true
    description: Current projection containing state, version, and unsubscribe marker.
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

`list-hygiene-judge` is a graph-runner style judgment that sits between engagement decay and durable consent-state transitions. It reads a contact projection keyed by `aggregate_id`, decides whether the contact should be re-permissioned, suppressed, verified, or stopped for human review, and records exactly one transition by compare-and-set append evidence when policy allows it.

The skill never sends a campaign, never emits an `operational_proposal`, and never mints a grant. Live delivery is dispatch-by-name to a separate governed `send-as` run, which must read the recorded consent state at send time and gate delivery.

## Contract

- Typed inputs are `data_source_ref`, `resource`, `aggregate_id`, `expected_version`, `idempotency_key`, `engagement_history{opens_count,clicks_count,hard_bounces,recency_days}`, `bounce_policy{hard_bounce_action,decay_threshold_days}`, and `current_consent_state`.
- Output is a `runx.list_hygiene_judgment.v1` packet containing:
  - `decision{state,reason}`
  - `data_store.read_projection`
  - `data_store.append_event` only when a transition is safe
  - `recorded_transition` read back from the simulated contact projection
  - `stop` when evidence is missing, stale, ambiguous, or blocked by unsubscribe.

## Decision rules

- `hard_bounces > 0` with `bounce_policy.hard_bounce_action = suppress` yields `decision.state = suppress` and one consent append.
- `recency_days > bounce_policy.decay_threshold_days` with no active unsubscribe marker yields `decision.state = re_permission` and one consent append.
- Fresh evidence with no hard bounce yields `decision.state = verify` and one append.
- Missing hard-bounce evidence, stale `expected_version`, ambiguous bounce recovery, or an active unsubscribe marker stops with no append and routes to `list_hygiene.human_review`.

## State and authority boundary

The state operation is modeled against `registry:runx/data-store@0.1.2` with pinned `store_id = runx-list-hygiene-judge-store-v1`:

1. `read_projection` for the contact `aggregate_id`
2. decide from read evidence only
3. `append_event(idempotency_key, expected_version)` as an ungated CAS write
4. read back the recorded transition

Retries with the same idempotency key are represented by the returned recorded version instead of double-applying. This skill only records consent state; `send-as` is the downstream enforcer.

## Local verification

```bash
runx harness ./skills/list-hygiene-judge
```

Dogfood after publish:

```bash
runx skill <owner>/list-hygiene-judge@0.1.0 --json \
  -i data_source_ref=registry:runx/data-store@0.1.2/demo/list-hygiene \
  -i resource=contact_consent_events \
  -i aggregate_id=contact:dogfood-decayed-001 \
  --input-json expected_version=4 \
  -i idempotency_key=contact:dogfood-decayed-001:list-hygiene:2026-06-30 \
  --input-json engagement_history='{"opens_count":0,"clicks_count":0,"hard_bounces":0,"recency_days":121}' \
  --input-json bounce_policy='{"hard_bounce_action":"suppress","decay_threshold_days":90}' \
  --input-json current_consent_state='{"state":"subscribed","version":4,"unsubscribe_marker":false}'
```
