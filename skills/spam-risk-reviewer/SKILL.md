---
name: spam-risk-reviewer
description: Review supplied campaign, list-hygiene, and sender-auth evidence and emit a bounded pre-send spam-risk verdict without sending a message.
runx:
  category: ops
---

# Spam Risk Reviewer

Judge whether one supplied campaign is clear for a separate governed `send-as`
preflight. This skill is read-only. It never sends a message, changes a list,
reads domain state, or grants authority.

## Inputs

- `campaign_draft`: `from`, `subject`, and `content_digest`.
- `list_metadata`: `size`, `bounce_rate`, `complaint_rate`, and `freshness`.
  `freshness` is the number of days since the list was last verified.
- `sender_auth_posture`: `spf_pass`, `dkim_pass`, `dmarc_pass`, and
  `warm_up_days`.

Treat all values as supplied evidence. Never infer a DNS result, list metric,
message body, or sender history that is not present.

## Bounded policy

Use these public thresholds:

- `bounce_rate` must be at most `0.02` (2%).
- `complaint_rate` must be at most `0.001` (0.1%).
- `freshness` must be at most `180` days.
- SPF, DKIM, and DMARC must all pass.
- A sender with fewer than 14 warm-up days requires human approval.

The thresholds are pre-send judgment rules only. They do not authorize
delivery.

## Verdict

Emit:

```yaml
schema: runx.send_risk.review.v1
send_risk_verdict:
  risk_level: pass | hold
  preflight_clear: true | false
  blockers: []
  evidence_summary:
    sender_auth:
      spf_pass: true
      dkim_pass: true
      dmarc_pass: true
      warm_up_days: 30
    list_hygiene:
      size: 1200
      bounce_rate:
        observed: 0.004
        maximum: 0.02
      complaint_rate:
        observed: 0.0002
        maximum: 0.001
      freshness:
        observed_days: 14
        maximum_days: 180
    content_risk_flags: []
escalation:
  status: none | needs_human
  lane: human_approval
  reason: ""
dispatch_target: send-as
```

Set `preflight_clear: true` only when all authentication checks pass, all list
metrics are inside the policy thresholds, and warm-up is sufficient. Otherwise
set `risk_level: hold`, preserve every grounded blocker, and set escalation to
`needs_human` in the `human_approval` lane.

`content_digest` identifies the reviewed draft but does not expose its body.
Do not invent content flags from the digest. Use an empty
`content_risk_flags` array unless a supplied value explicitly supports a flag.

## Dispatch boundary

`dispatch_target: send-as` is only a handoff name. A separate governed
`send-as` run reads `preflight_clear` and `blockers` into its preflight.
A non-clear verdict prevents that run from satisfying preflight and routes it
to human approval. The `public_send` Effect and actual delivery belong only to
that separate run.

This skill emits no `runx.operational_proposal.v1`, mints no authority, reads
no domain state, and never executes `send-as`.

## Local verification

```bash
runx --version
runx harness ./skills/spam-risk-reviewer
```

The inline harness declares exactly two cases:

- `low-risk-verified-sender`: full authentication and clean list evidence
  produce a clear verdict with no blockers.
- `high-risk-incomplete-auth-poor-list`: failed DKIM and a 6% bounce rate
  produce a hold verdict with two grounded blockers and human escalation.

