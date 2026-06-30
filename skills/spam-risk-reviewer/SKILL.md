---
name: spam-risk-reviewer
version: "0.1.0"
description: Read-only pre-send spam risk judgment for campaign drafts, list hygiene signals, and sender authentication posture.
---

# spam-risk-reviewer

`spam-risk-reviewer` is a dispatch-free pre-send judgment skill. It reads a bounded campaign draft, list metadata, sender authentication posture, and spam policy thresholds, then emits a typed `send_risk_verdict` packet.

The skill never sends a message, never creates an operational proposal, never mints authority, and never reads live domain state. A later governed `send-as` run may read the verdict into its own preflight, where any non-clear verdict blocks sending and routes to human approval.

## Inputs

- `campaign_draft`: `{ from, subject, content_digest }` for the proposed send.
- `list_metadata`: `{ size, bounce_rate, complaint_rate, freshness_days }` for the audience list.
- `sender_auth_posture`: `{ spf_pass, dkim_pass, dmarc_pass, warm_up_days }` for the sender.
- `policy`: `{ max_bounce_rate, max_complaint_rate, max_freshness_days, min_warm_up_days, risky_content_terms }`.

## Decision rules

- Return `risk_level: pass` and `preflight_clear: true` only when SPF, DKIM, and DMARC all pass, list metrics are inside policy thresholds, warm-up days meet the policy floor, and no risky content terms are found.
- Return `risk_level: hold`, `preflight_clear: false`, and a blocker list when sender authentication fails, list health exceeds thresholds, the sender is not warmed up, or risky content appears in the bounded digest.
- Return `escalation: needs_human` whenever the verdict is not clear.
- Refuse missing or invented signals; every blocker is grounded in the supplied input.

## Output

The default runner emits:

- `send_risk_verdict`: `{ risk_level, preflight_clear, blockers, evidence_summary }`.
- `risk_level`: shorthand verdict level.
- `preflight_clear`: boolean send-as preflight signal.
- `blockers`: grounded blocker reasons.
- `escalation`: `null` for pass, `needs_human` for hold.

## Validation

Run the local harness from the repository root:

```bash
runx harness ./skills/spam-risk-reviewer
```

Expected cases:

- `low-risk-verified-sender`
- `high-risk-incomplete-auth`
- `missing-policy-stop`