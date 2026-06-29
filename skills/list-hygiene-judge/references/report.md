# list-hygiene-judge report

Package: `list-hygiene-judge`  
Version: `0.1.0`  
Publisher: `lxx197818`  
Registry ref: `lxx197818/list-hygiene-judge@0.1.0`

## What this skill does

`list-hygiene-judge` reads contact consent and engagement evidence, decides
whether the contact should be verified, suppressed, or moved into a
re-permission lane, and records that decision as a compare-and-set
`append_event` on the contact stream.

The skill never sends a message and never emits an operational proposal. Later
delivery is delegated by name to `send-as`, which must read the recorded consent
state at send time.

## Harness coverage

- `sealed_decay_re_permission`: stale engagement with no unsubscribe marker
  records `contact.consent_state.re_permission_required`.
- `sealed_hard_bounce_suppress`: a hard bounce records
  `contact.consent_state.suppressed`.
- `stop_missing_or_stale_evidence`: stale `expected_version` stops without an
  append and routes to `list_hygiene.review`.

Local harness command:

```bash
runx harness ./skills/list-hygiene-judge -j
```

Local harness result: passed, 3 cases, 0 assertion errors.

## Dogfood receipt

The dogfood run used `runx-cli 0.6.14` and produced sealed receipt:

```text
sha256:e6937a46f3813c19181a367d0702a79b7c6b2c88d16f93fd7157f3829f9b8c33
```

The run read `contact:demo-001`, observed `recency_days=120`, compared it to a
`decay_threshold_days=90`, and recorded a `re_permission` transition at version
4 with idempotency key `contact:demo-001:list-hygiene:2026-06-29`.

## Install and run

```bash
runx add lxx197818/list-hygiene-judge@0.1.0
runx skill lxx197818/list-hygiene-judge@0.1.0 --json \
  -i data_source_ref=local://runx/list-hygiene/demo \
  -i resource=contact_consent_events \
  -i aggregate_id=contact:demo-001 \
  --input-json expected_version=3 \
  -i idempotency_key=contact:demo-001:list-hygiene:2026-06-29 \
  --input-json engagement_history='{"opens_count":0,"clicks_count":0,"hard_bounces":0,"recency_days":120}' \
  --input-json bounce_policy='{"hard_bounce_action":"suppress","decay_threshold_days":90}' \
  --input-json current_consent_state='{"state":"subscribed","version":3,"unsubscribe_marker":false}'
```

Expected output packet: `runx.list_hygiene_judgment.v1`.

## Public artifacts

- Public URL: `https://runx.ai/x/lxx197818/list-hygiene-judge@0.1.0`
- PR URL: `https://github.com/runxhq/runx/pull/174`
- Source URL: `https://github.com/lxx197818/runx/tree/codex/list-hygiene-judge-68/skills/list-hygiene-judge`
- X.yaml: `https://raw.githubusercontent.com/lxx197818/runx/codex/list-hygiene-judge-68/skills/list-hygiene-judge/X.yaml`
- SKILL.md: `https://raw.githubusercontent.com/lxx197818/runx/codex/list-hygiene-judge-68/skills/list-hygiene-judge/SKILL.md`
