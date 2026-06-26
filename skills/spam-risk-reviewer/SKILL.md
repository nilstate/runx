---
name: spam-risk-reviewer
description: Review campaign draft, list hygiene, and sender authentication signals before send-as preflight.
source:
  type: cli-tool
  command: node
  args:
    - run.mjs
  timeout_seconds: 30
  sandbox:
    profile: readonly
    cwd_policy: skill-directory
inputs:
  campaign_draft:
    type: json
    required: true
    description: Sender, subject, and content digest for the campaign draft.
  list_metadata:
    type: json
    required: true
    description: List size, bounce rate, complaint rate, and freshness evidence.
  sender_auth_posture:
    type: json
    required: true
    description: SPF, DKIM, DMARC, and warm-up posture for the sender.
runx:
  category: deliverability
  input_resolution:
    required:
      - campaign_draft
      - list_metadata
      - sender_auth_posture
---

# spam-risk-reviewer

## What this skill does

`spam-risk-reviewer` is a read-only pre-send judgment for outbound campaigns. It
reviews a supplied `campaign_draft`, `list_metadata`, and
`sender_auth_posture`, then emits a deterministic `send_risk_verdict` packet
for a later governed `send-as` run to read during preflight.

The skill does not send messages, call a live provider, mint authority, change
domain state, or emit `runx.operational_proposal.v1`. The only dispatch it names
is a downstream `send-as` preflight target; the actual `public_send` effect
stays owned by `send-as` under its own scope, gate, proof, and receipt trail.

## When to use this skill

Use this skill before a governed campaign send when an operator needs a
portable spam-risk decision from evidence already in hand. It is suitable for
CI, review queues, and send-preflight graphs where the sender, list, and content
digest are available as structured inputs.

Use it when the caller can provide:

- `campaign_draft.from`, `campaign_draft.subject`, and
  `campaign_draft.content_digest`;
- `list_metadata.size`, `list_metadata.bounce_rate`,
  `list_metadata.complaint_rate`, and `list_metadata.freshness`;
- `sender_auth_posture.spf_pass`, `sender_auth_posture.dkim_pass`,
  `sender_auth_posture.dmarc_pass`, and
  `sender_auth_posture.warm_up_days`.

## When not to use this skill

Do not use it as the final send authority or as proof that a mailbox provider
accepted a campaign. Do not use it when the decision requires live ISP feedback,
provider API state, recipient-level suppression checks, legal consent review, or
creative rewriting. Those belong in separate governed skills or human review.

Do not pass secrets, SMTP credentials, recipient addresses, or raw message
bodies. The skill expects metadata and a stable content digest, not deliverable
content.

## Procedure

1. Confirm the draft identifies a sender, subject, and content digest.
2. Confirm the list metadata includes size, bounce rate, complaint rate, and
   freshness days.
3. Confirm the sender authentication posture includes SPF, DKIM, DMARC, and
   warm-up days.
4. Compare the evidence to the local policy thresholds:
   bounce rate at or below `0.02`, complaint rate at or below `0.001`, freshness
   at or below `90` days, warm-up at least `14` days, and SPF/DKIM/DMARC all
   passing.
5. Emit `risk_level: pass`, `preflight_clear: true`, and no blockers when every
   signal clears policy.
6. Emit `risk_level: hold`, `preflight_clear: false`, concrete blockers, and a
   `needs_human` escalation when any signal is missing or outside policy.
7. Bind the verdict to the named downstream `send-as` preflight surface only;
   never perform the send directly.

## Edge cases and stop conditions

The skill returns a hold verdict when SPF, DKIM, or DMARC is false or missing;
when bounce rate, complaint rate, freshness, or warm-up violates policy; when
the campaign draft is incomplete; when list size is zero or missing; or when the
subject/content digest label contains coarse high-risk terms.

Missing or malformed evidence is treated as a blocker rather than guessed. The
decision is effectively refused for preflight clearance until the operator
supplies complete evidence or sends the case through a separate human approval
lane.

## Output schema

The runner writes one JSON packet to stdout with schema
`runx.send.spam_risk_review.v1`.

```json
{
  "schema": "runx.send.spam_risk_review.v1",
  "send_risk_verdict": {
    "risk_level": "pass",
    "preflight_clear": true,
    "blockers": [],
    "evidence_summary": {
      "authentication": {
        "spf_pass": true,
        "dkim_pass": true,
        "dmarc_pass": true,
        "warm_up_days": 30
      },
      "list_hygiene": {
        "bounce_rate": 0.004,
        "complaint_rate": 0.0002,
        "freshness_days": 21
      },
      "content_risk_flags": []
    }
  },
  "dispatch_target": {
    "name": "send-as",
    "type": "named_downstream"
  },
  "escalation": {
    "lane": "none",
    "required": false
  }
}
```

For hold verdicts, `send_risk_verdict.blockers` contains the concrete policy
reasons, `dispatch_target.typed_inputs.blockers` carries the same blockers for
`send-as`, and `escalation.lane` is `needs_human`.

## Worked example

For a verified sender with full authentication, a clean list, and recent consent
evidence, the runner emits:

```json
{
  "send_risk_verdict": {
    "risk_level": "pass",
    "preflight_clear": true,
    "blockers": []
  }
}
```

For a sender where DKIM fails and the list bounce rate is `0.075`, the runner
emits:

```json
{
  "send_risk_verdict": {
    "risk_level": "hold",
    "preflight_clear": false,
    "blockers": [
      "authentication: DKIM does not pass",
      "list_hygiene: bounce_rate 0.075 exceeds policy max 0.02"
    ]
  },
  "escalation": {
    "lane": "needs_human",
    "required": true
  }
}
```

## Inputs

| Name | Required | Description |
| --- | --- | --- |
| `campaign_draft` | yes | JSON object with `from`, `subject`, and `content_digest`. |
| `list_metadata` | yes | JSON object with `size`, `bounce_rate`, `complaint_rate`, and `freshness.days_since_last_confirmed`. |
| `sender_auth_posture` | yes | JSON object with `spf_pass`, `dkim_pass`, `dmarc_pass`, and `warm_up_days`. |
| `harness_case` | no | Optional fixture label recorded in evidence. |
