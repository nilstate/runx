---
name: list-hygiene-judge
description: Judge a consent-state transition from explicit engagement and bounce evidence, record it durably through data-store, and stop safely when evidence is missing, unsubscribed, or stale.
runx:
  category: growth
links:
  source: https://github.com/runxhq/runx/pull/402
license: MIT
---

# List Hygiene Judge

`list-hygiene-judge` is a bounded graph runner for one contact entity. It reads
the contact projection, evaluates explicit engagement and bounce evidence, and
records one consent-state transition through the governed data-store adapter.
It never sends a campaign, invents metrics, or treats a receipt as proof that a
downstream message was delivered.

## Decisions

- `suppress` when `hard_bounces > 0` and the supplied policy says to suppress.
- `re_permission` when recency exceeds the supplied decay threshold and no
  active unsubscribe marker is present.
- `retain` when evidence is valid but neither transition is justified.
- `stop` when evidence is missing, an unsubscribe marker is active, or the
  expected projection version is stale.

## Durable guard

The graph reads the contact projection before judging. A transition is appended
only when the read version equals `expected_version`; the append carries the
caller-supplied `idempotency_key` and event payload. The projection is read back
after a successful append. A retry with the same idempotency key is surfaced as
an idempotent replay by the data adapter. A stop path emits no append.

## Inputs

- `data_source_ref`, `resource`, and `aggregate_id` identify the contact stream.
- `expected_version` is the compare-and-set version from the caller.
- `idempotency_key` binds one logical transition across retries.
- `engagement_history` must contain opens, clicks, hard bounces, and recency;
  the skill does not derive those values.
- `bounce_policy` supplies the hard-bounce action and decay threshold.
- `current_consent_state` supplies the current state and unsubscribe marker.

## Safety boundaries

This skill does not send email, mutate a provider other than the declared data
source, bypass an unsubscribe marker, or write when the projection version is
stale. Missing or unreadable evidence is a governed stop, not a guess.

## Example

```bash
runx skill list-hygiene-judge decide \
  -i data_source_ref=tenant://example/contacts \
  -i resource=contacts \
  -i aggregate_id=contact:alice \
  -i expected_version=0 \
  -i idempotency_key=alice:consent:v1 \
  --input-json engagement_history='{"opens_count":4,"clicks_count":1,"hard_bounces":0,"recency_days":120}' \
  --input-json bounce_policy='{"hard_bounce_action":"suppress","decay_threshold_days":90}' \
  --input-json current_consent_state='{"state":"suppressed","unsubscribe_active":false}' \
  --json
```
