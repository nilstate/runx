# escalation-judge bounty packet draft

Package: `escalation-judge@0.1.0`

Prepared for Frantic #69. This directory is a pre-publish package draft and has not been delivered to Frantic.

## What is included

- `skills/escalation-judge/SKILL.md`
- `skills/escalation-judge/X.yaml`
- `skills/escalation-judge/run.mjs`
- `skills/escalation-judge/fixtures/`
- `evidence.json`
- `verification.json`

## Harness coverage

- `sealed_priority_escalation`: `triage_packet.severity=sev1` crosses named threshold `sev2_or_higher_priority_support`, and the thread body grounds churn signals `renewal_blocked` / `will cancel`. The skill appends a durable case record and emits one typed escalation packet naming `slack://support-priority`.
- `stop_no_threshold_no_change`: low-severity how-to thread meets no severity threshold and no grounded churn signal. The skill seals `decision.escalate=false`, reason `no_change`, no append, and no packet.

## State model

The packet names `registry:runx/data-store@0.1.2`, pinned `store_id=runx-escalation-judge-store-v1`, and the shape `read_projection -> decide -> append_event(idempotency_key, expected_version)`. The append is an ungated CAS case write, not a proposal.

## Authority boundary

This skill never posts or sends. If escalation is warranted, it emits a packet naming the downstream target rail and driver. A separate governed `slack-notify` or `send-as` run performs the egress.

## Pending before Frantic delivery

1. Claimant GitHub identity must be verified and must star `https://github.com/runxhq/runx`.
2. Open a public PR against `runxhq/runx` containing `skills/escalation-judge`.
3. Publish with `runx registry publish ./skills/escalation-judge/SKILL.md --registry https://api.runx.ai`.
4. Run clean install, hosted harness, post-publish dogfood, and `runx verify --receipt`.
5. Replace placeholder public URLs, raw URLs, receipt_ref, and verification status in `evidence.json` and `verification.json`.
