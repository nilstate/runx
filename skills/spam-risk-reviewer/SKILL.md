---
name: spam-risk-reviewer
description: Read a campaign draft, list hygiene signals, and sender authentication posture, then emit a bounded send_risk_verdict for send-as preflight.
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
  campaign_draft:
    type: json
    required: true
    description: campaign_draft{from, subject, content_digest}
  list_metadata:
    type: json
    required: true
    description: list_metadata{size, bounce_rate, complaint_rate, freshness}
  sender_auth_posture:
    type: json
    required: true
    description: sender_auth_posture{spf_pass, dkim_pass, dmarc_pass, warm_up_days}
runx:
  category: deliverability
  input_resolution:
    required:
      - campaign_draft
      - list_metadata
      - sender_auth_posture
---

# Spam Risk Reviewer

`spam-risk-reviewer` is a read-only pre-send judgment skill. It reviews a
campaign draft, subscriber-list metadata, and sender-authentication posture, then
emits a bounded `send_risk_verdict`.

The skill never sends mail, never mints authority, never writes domain state, and
never emits `runx.operational_proposal.v1`. A separate governed `send-as` run
reads the verdict by name into its `preflight_required` and `blockers`. If this
skill returns any non-clear verdict, send-as cannot satisfy preflight and must
route to the human approval lane. The `public_send` effect belongs only to
send-as.

## Contract

Inputs:

- `campaign_draft{from, subject, content_digest}`
- `list_metadata{size, bounce_rate, complaint_rate, freshness}`
- `sender_auth_posture{spf_pass, dkim_pass, dmarc_pass, warm_up_days}`

Output:

- `send_risk_verdict{risk_level, preflight_clear, blockers, evidence_summary}`

## Policy thresholds

- SPF, DKIM, and DMARC must all pass.
- `bounce_rate` must be at or below `0.02`.
- `complaint_rate` must be at or below `0.001`.
- `freshness` is interpreted as max list age in days and must be at or below
  `90`.
- `warm_up_days` must be at least `14` for automated clearance.
- Content flags such as urgency, guarantees, or free-money wording lower the
  verdict but do not invent metrics.

## Decision behavior

- Clear authenticated sender plus clean list signals yields
  `risk_level: pass`, `preflight_clear: true`, and `blockers: []`.
- Missing SPF, DKIM, or DMARC, poor list hygiene, or stale freshness yields
  `risk_level: hold`, `preflight_clear: false`, concrete blocker reasons, and
  `needs_human` for `send-as.human_approval`.
- Missing required metrics are refused as ungrounded; the skill does not guess
  authentication or list-health values.

## Verification

Local harness:

```bash
runx harness ./skills/spam-risk-reviewer
```

Example dogfood run:

```bash
runx skill ./skills/spam-risk-reviewer --json \
  --input-json campaign_draft='{"from":"newsletter@example.com","subject":"June product notes for active customers","content_digest":"Monthly release notes and support office hours."}' \
  --input-json list_metadata='{"size":12500,"bounce_rate":0.003,"complaint_rate":0.0002,"freshness":21}' \
  --input-json sender_auth_posture='{"spf_pass":true,"dkim_pass":true,"dmarc_pass":true,"warm_up_days":45}'
```
