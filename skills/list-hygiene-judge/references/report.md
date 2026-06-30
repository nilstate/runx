# list-hygiene-judge bounty packet draft

Package: `list-hygiene-judge@0.1.0`

Prepared for Frantic #68. This directory is a pre-publish package draft and has not been delivered to Frantic.

## What is included

- `skills/list-hygiene-judge/SKILL.md`
- `skills/list-hygiene-judge/X.yaml`
- `skills/list-hygiene-judge/run.mjs`
- `skills/list-hygiene-judge/fixtures/`
- `evidence.json`
- `verification.json`

## Harness coverage

- `sealed_decay_re_permission`: decayed contact has `recency_days=121`, policy threshold is `decay_threshold_days=90`, no unsubscribe marker, so the skill records `new_state=re_permission`.
- `sealed_hard_bounce_suppress`: contact has `hard_bounces=1` and `hard_bounce_action=suppress`, so the skill records `new_state=suppress`.
- `stop_missing_or_stale_evidence`: `expected_version=2` but projection version is `3`, so the skill stops with `stale_expected_version` and emits no append.

## State model

The packet names `registry:runx/data-store@0.1.2`, pinned `store_id=runx-list-hygiene-judge-store-v1`, and the shape `read_projection -> decide -> append_event(idempotency_key, expected_version) -> readback`. The write is modeled as ungated CAS evidence, not a proposal.

## Authority boundary

This skill never sends. It records consent state only. Campaign delivery remains a separate governed `send-as` run that reads the recorded state at send time.

## Pending before Frantic delivery

1. Claimant GitHub identity must be verified and must star `https://github.com/runxhq/runx`.
2. Open a public PR against `runxhq/runx` containing `skills/list-hygiene-judge`.
3. Publish with `runx registry publish ./skills/list-hygiene-judge/SKILL.md --registry https://api.runx.ai`.
4. Run clean install, hosted harness, post-publish dogfood, and `runx verify --receipt`.
5. Replace placeholder public URLs, raw URLs, receipt_ref, and verification status in `evidence.json` and `verification.json`.
