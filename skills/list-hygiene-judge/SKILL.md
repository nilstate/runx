---
name: list-hygiene-judge
version: "0.1.0"
description: Decide list hygiene transitions for a contact projection and append only safe suppress or re-permission events.
---

# list-hygiene-judge

`list-hygiene-judge` is a dispatch-free list hygiene review skill for contact consent state. It reads the contact projection, decides whether the contact should be suppressed, moved to re-permission, or escalated for human review, then appends at most one transition event through the data-store compare-and-set path.

The skill does not send messages, does not mint grants, and does not return an `operational_proposal` envelope. Any later send-as workflow is intentionally separate and governed.

## Inputs

- `data_source_ref`: data-store source reference for the contact event stream.
- `resource`: resource name used by the contact list-hygiene stream.
- `aggregate_id`: contact aggregate id.
- `expected_version`: stream version required before append.
- `idempotency_key`: stable retry key for the transition.
- `engagement_history`: object with `opens_count`, `clicks_count`, `hard_bounces`, and `recency_days`.
- `bounce_policy`: object with `hard_bounce_action` and `decay_threshold_days`.
- `current_consent_state`: object describing the current consent posture, including any unsubscribe marker and the evidence source.

## Decision rules

- If `hard_bounces > 0` and the contact projection or supplied consent evidence does not contain an active unsubscribe blocker, return `decision.state = suppress` and append exactly one `list_hygiene.transitioned` event.
- If `recency_days > decay_threshold_days`, `hard_bounces == 0`, and there is no active unsubscribe marker, return `decision.state = re_permission` and append exactly one `list_hygiene.transitioned` event.
- If engagement evidence is missing, unreadable, stale, ambiguous, or not tied to the current stream version, return `decision.state = human_review` and do not append.
- If an active unsubscribe marker is present, return `decision.state = human_review` and do not append.
- If `expected_version` does not match the contact stream, the data-store append is refused by compare-and-set and no second write path is attempted.
- Re-running with the same `idempotency_key` must reuse the recorded transition instead of double-applying it.

## Output

The graph returns:

- `decision`: `{ state, reason }`.
- `recorded_transition`: the transition event selected for append, or the human-review stop record when no append is allowed.
- `readback`: contact projection read after the graph finishes, so callers can verify the recorded state.

## Data-store contract

The graph uses the canonical data-store append path from `registry:runx/data-store@sha-83a2cad9dd67`, the live first-party registry package for source `data-store` version `0.1.2`, so clean installs resolve a pinned data-store contract.

## Refusals

This skill refuses to:

- suppress a contact when hard-bounce evidence was not read from the declared contact evidence packet;
- re-permission a contact with an active unsubscribe marker;
- invent opens, clicks, hard bounces, recency, consent, or version values;
- write on stale or mismatched `expected_version`;
- combine the hygiene decision with outbound send-as delivery.

## Validation

Run the local harness from the repository root:

```bash
runx harness ./skills/list-hygiene-judge
```

Expected cases:

- `sealed_decay_re_permission`
- `sealed_hard_bounce_suppress`
- `stop_missing_or_stale_evidence`
