---
name: spam-risk-reviewer
description: Review campaign, list hygiene, and sender authentication metadata before send-as preflight.
source:
  type: cli-tool
  command: node
  args:
    - run.mjs
  timeout_seconds: 10
  sandbox:
    profile: readonly
    cwd_policy: skill-directory
runx:
  category: deliverability
  tags:
    - deliverability
    - spam-risk
    - send-as-preflight
links:
  source: https://github.com/runxhq/runx/tree/main/skills/spam-risk-reviewer
---

# Spam Risk Reviewer

`spam-risk-reviewer` is a read-only pre-send judgment skill for campaign
deliverability. It reviews three typed inputs:

- `campaign_draft{from, subject, content_digest}`
- `list_metadata{size, bounce_rate, complaint_rate, freshness}`
- `sender_auth_posture{spf_pass, dkim_pass, dmarc_pass, warm_up_days}`

The skill emits `send_risk_verdict{risk_level, preflight_clear, blockers,
evidence_summary}`. It never sends mail, never changes DNS, never mutates a
subscriber list, never mints authority, and never reads domain state outside the
provided inputs.

## Decision Contract

- `risk_level: pass` and `preflight_clear: true` are allowed only when SPF, DKIM,
  and DMARC all pass, warm-up is sufficient, and the list is under bounce,
  complaint, and freshness thresholds.
- Missing or failed SPF, DKIM, or DMARC always blocks preflight clearance.
- Bounce, complaint, freshness, or warm-up failures block preflight clearance.
- Borderline or high-risk verdicts emit `needs_human` so a governed send-as
  workflow can route the campaign to human approval.
- The public send effect belongs to a separate governed send-as run. This skill
  only emits a named verdict for send-as preflight.

## Default Policy

- Maximum bounce rate: `0.02`
- Maximum complaint rate: `0.001`
- Maximum list freshness in days: `90`
- Minimum warm-up days: `14`

Callers may pass a `policy` object to make those thresholds stricter or to test
an explicit operating posture. The skill refuses to invent authentication or
list metrics. If required inputs are missing or malformed, it returns a hold
verdict with blocker reasons.

## Harness Cases

- `low-risk-verified-sender`: a verified sender with clean list signals and full
  authentication yields `send_risk_verdict{risk_level: pass,
  preflight_clear: true, blockers: []}`.
- `high-risk-incomplete-auth-poor-list`: DKIM failure plus high bounce rate,
  high complaint rate, stale list age, short warm-up, and urgency copy yields
  `send_risk_verdict{risk_level: hold, preflight_clear: false,
  blockers: [...]}` and `needs_human`.

## Output

The CLI writes one JSON object to stdout:

```json
{
  "send_risk_verdict": {
    "risk_level": "pass | review | hold",
    "preflight_clear": false,
    "blockers": [],
    "evidence_summary": []
  },
  "evidence_json": {
    "schema": "spam.risk.reviewer.evidence.v1",
    "observations": []
  },
  "report_md": "# Spam Risk Reviewer Report\n..."
}
```

When `output_dir` is provided, the skill also writes `evidence.json` and
`report.md` inside that directory under the skill root.
