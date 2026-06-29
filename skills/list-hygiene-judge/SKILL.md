---
name: list-hygiene-judge
description: Decide whether a contact should be re-permissioned, suppressed, or escalated, then record the transition exactly once using compare-and-set.
runx:
  category: ops
---

# List Hygiene Judge

Evaluate a single contact's engagement history, bounce record, and consent state,
then write exactly one auditable transition to the contact's event stream — or
stop without writing when evidence is missing, stale, or the contact has an
active unsubscribe marker.

This skill owns the consent-state decision engine. It never sends messages and
never emits an operational proposal or minted grant. Delivery is the downstream
concern of a `send-as` run. The hygiene judge determines which lane the contact
belongs in and seals that decision as a verifiable receipt-bound event.

The skill never invents engagement metrics or bounce counts it cannot read from
the provided data. If `engagement_history` is absent or malformed, the skill
stops rather than assuming safe defaults.

## What this skill does

1. Reads caller-supplied `engagement_history`, `bounce_policy`, and
   `current_consent_state` from the run inputs.
2. Compares `expected_version` against the version embedded in
   `current_consent_state`. Stops with `stale_expected_version` if they differ.
3. Checks for an active unsubscribe marker. Stops with `active_unsubscribe_marker`
   if present; never overridden by decay logic.
4. Evaluates hard bounces. If `engagement_history.hard_bounces > 0`, decides
   `suppress`.
5. Evaluates recency decay. If `engagement_history.recency_days` exceeds
   `bounce_policy.decay_threshold_days`, decides `re_permission`.
6. On `suppress` or `re_permission`, appends exactly one `consent.transition`
   event using `registry:runx/data-store@0.1.2` with `expected_version` and
   `idempotency_key` for compare-and-set.
7. On any stop path, emits no append and records the stop code and reason. A
   human approval lane (`list_hygiene.review`) handles escalation.

## Core principles

- **Hard bounces take priority.** A non-zero `hard_bounces` value always resolves
  to `suppress` before recency is evaluated.
- **Active unsubscribe is terminal.** A contact with `unsubscribe_marker: true` or
  `state: unsubscribed` is never automatically re-permissioned.
- **One write per run.** The `idempotency_key` prevents duplicate transitions. A
  retry with the same key and same payload is a no-op.
- **Version mismatch escalates.** If `expected_version` does not match the
  version in `current_consent_state`, the run stops with `stale_expected_version`
  and no append is written.
- **No invented metrics.** All engagement and bounce data must come from the
  caller-provided `engagement_history` object. The skill never generates or
  assumes values.

## When to use this skill

- A list-hygiene pipeline needs to classify a contact before a send run.
- A compliance workflow must produce a receipt-bound record of every consent
  state change.
- An operator wants deterministic, auditable re-permission decisions without
  exposing raw contact data to downstream skills.

## When not to use this skill

- To send or schedule messages. Use `send-as` for delivery.
- To evaluate consent for an entire list in one call. Run one judge per contact.
- To make decisions when the contact has an active unsubscribe marker.
- To bypass human review for version conflicts or ambiguous evidence.

## Decision procedure

1. Validate that all required inputs are present. Stop with `needs_evidence` if
   any required field is absent or cannot be parsed.
2. Parse `current_consent_state.version` as a number. Stop with
   `missing_current_projection_version` if it is not a finite non-negative number.
3. Compare `expected_version` with `current_consent_state.version`. Stop with
   `stale_expected_version` if they differ.
4. Check `unsubscribe_marker` and `state` for active unsubscribe. Stop with
   `active_unsubscribe_marker` if found.
5. Validate all four engagement metrics (`opens`, `clicks`, `hard_bounces`,
   `recency_days`). Stop with `missing_or_invalid_<field>` if any is absent or
   not a finite non-negative number.
6. Validate `bounce_policy.decay_threshold_days`. Stop with
   `missing_decay_threshold` if absent or invalid.
7. If `hard_bounces > 0`, decide `suppress` with event type
   `contact.consent_state.suppressed`.
8. If `recency_days > decay_threshold_days`, decide `re_permission` with event
   type `contact.consent_state.re_permission_required`.
9. Otherwise, decide `active` with event type `contact.consent_state.verified`.
10. For `suppress` or `re_permission`, call the data adapter with
    `data_source_ref`, `resource`, `aggregate_id`, `expected_version`, and
    `idempotency_key`. The event carries the decision state and reason.
11. Return the output with `decision.state`, `decision.reason`, and
    `recorded_transition` (null on stop paths).

## Stop conditions

- `missing_current_projection_version` — `current_consent_state.version` is
  absent or not a finite number.
- `stale_expected_version` — `expected_version` does not match
  `current_consent_state.version`. No append is written.
- `active_unsubscribe_marker` — contact has an active unsubscribe marker or
  `state` of `unsubscribed`. No automated re-permission.
- `missing_or_invalid_<field>` — engagement metric is absent or not a finite
  non-negative number.
- `missing_decay_threshold` — `bounce_policy.decay_threshold_days` is absent
  or invalid.

## Output schema

```
schema: runx.list_hygiene.decision.v1
aggregate_id: <contact id>
decision:
  state: re_permission | suppress | active | stop
  reason: <explanation>
data_store:
  read_projection: <projection evidence>
  append_event: <committed event or null>
recorded_transition: <readback projection or null>
stop: <stop block or null>
no_send: true
no_operational_proposal: true
```

The skill never includes contact PII, raw credentials, or secret material in
the output.

## Worked example

A contact has `recency_days: 120` against a `decay_threshold_days: 90` policy,
`hard_bounces: 0`, and `current_consent_state: {state: active, version: 3}` with
`expected_version: 3`. The judge decides `re_permission`, appends a
`contact.consent_state.re_permission_required` event, and seals the receipt. A
downstream `send-as` run reads the updated consent state before building its
send plan.

A second contact has `hard_bounces: 3`. Regardless of recency, the judge decides
`suppress`, appends the transition, and seals the receipt.

A third contact has `current_consent_state.version: 4` but the caller supplied
`expected_version: 2`. The judge stops with `stale_expected_version` and writes
nothing. The pipeline reloads the stream and retries with the correct version.

## Inputs

- `data_source_ref` (required): stable logical ref bound by the operator to the
  contact data adapter.
- `resource` (required): declared event resource for contact consent transitions.
- `aggregate_id` (required): contact stream partition key.
- `expected_version` (required): stream version the caller believes is current.
  Must match `current_consent_state.version` or the run stops.
- `idempotency_key` (required): stable retry key for this decision cycle.
- `engagement_history` (required): object with `opens` (int), `clicks` (int),
  `hard_bounces` (int), and `recency_days` (int).
- `bounce_policy` (required): object with `hard_bounce_action` (suppress) and
  `decay_threshold_days` (int).
- `current_consent_state` (required): object with `state`
  (active|pending|unsubscribed|unknown), `version` (int), and `unsubscribe_marker`
  (bool).
