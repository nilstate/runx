---
name: spam-risk-reviewer
description: Judge one campaign send against sealed list hygiene and sender-auth posture, then emit a bounded send_risk_verdict for downstream governed lanes.
runx:
  category: ops
---

# Spam Risk Reviewer

`spam-risk-reviewer` decides whether a campaign send should be allowed to leave
the operator queue. It is a read-only judgment skill: it never sends mail,
mutates list state, mints authority, or executes a campaign send.

The default `spam_risk` runner is a graph with a thin `review` act. Its verdict
step is an agent-mediated judgment, so an unattended run stops at `needs_agent`
instead of fabricating a verdict. The bounded `dogfood` runner applies the same
checked contract deterministically for reproducible post-publish evidence.

The useful output is a single `send_risk_verdict`. A downstream `send-as` run
reads the verdict into its `preflight_required` and `blockers` slots; a non-clear
verdict prevents `send-as` from satisfying its preflight and routes the call to
the human approval lane. The `public_send` Effect stays `send-as`'s own, and
the actual delivery is that separate governed `send-as` run.

## What This Skill Does

The skill reads three pieces of evidence:

- `campaign_draft{from, subject, content_digest}`
- `list_metadata{size, bounce_rate, complaint_rate, freshness}`
- `sender_auth_posture{spf_pass, dkim_pass, dmarc_pass, warm_up_days}`

It verifies the sender has all three auth signals passing, checks the list
hygiene metrics against policy thresholds (default: bounce_rate <= 0.05,
complaint_rate <= 0.001, freshness <= 30 days idle), and inspects the
content digest for known risk flags. When the verdict is `pass`, the
verdict sets `preflight_clear: true` with an empty `blockers`. When the
verdict is `hold` or `block`, the verdict sets `preflight_clear: false`
and lists every blocker reason.

The skill never invents an authentication signal it cannot ground, never
clears preflight when any auth signal is missing or any policy threshold
is violated, and never executes the send.

## When To Use It

- An operator has a campaign draft and needs a receipt-backed spam-risk
  decision before `send-as` is allowed to dispatch.
- A workflow needs to prove which auth signals and which hygiene metrics
  justified clearing or holding the send.
- A run should separate judgment from action, so humans can review the
  verdict before any mail is dispatched.

## When Not To Use It

- To actually send, queue, schedule, or otherwise move a campaign. Use a
  downstream governed `send-as` run for that effect.
- To clear a send whose authentication signals are absent, missing, or
  fabricated.
- To clear a send whose list violates the bounce, complaint, or freshness
  threshold.
- To make up missing campaign fields, list metrics, or auth posture
  signals.

## Procedure

1. Read `campaign_draft`, `list_metadata`, `sender_auth_posture` and reject
   any missing or unclear top-level object.
2. Validate that `from` is a string, `subject` is a string, and
   `content_digest` is a string.
3. Confirm `sender_auth_posture` for each of `spf_pass`, `dkim_pass`,
   `dmarc_pass`, and `warm_up_days`. If any is missing or non-boolean
   where boolean is required, set `preflight_clear: false` and add a
   blocker reason naming the missing signal.
4. Confirm `list_metadata` for each of `size`, `bounce_rate`,
   `complaint_rate`, and `freshness`. If any is missing, set
   `preflight_clear: false` and add a blocker reason.
5. Inspect `content_digest` for known spam-risk patterns (e.g.
   "free money", "click here now"). For each pattern, add a blocker
   reason and set `risk_level` to `hold` (or `block` when combined with
   auth failure).
6. Compute the verdict:
   - `risk_level: pass` and `preflight_clear: true` if all auth signals
     pass and all hygiene metrics are within policy and no content risk
     flags were found.
   - `risk_level: hold` and `preflight_clear: false` if any policy
     threshold is violated or any auth signal is missing or any content
     risk flag is found. The verdict must include at least one blocker
     reason and must signal `needs_human` escalation.
   - `risk_level: block` and `preflight_clear: false` if any hard
     violation (auth fails and bounce rate exceeds policy) is present.
7. Emit the `send_risk_verdict` described below.

## Output Contract

```yaml
send_risk_verdict:
  risk_level: pass | hold | block
  preflight_clear: bool
  blockers:
    - string
  evidence_summary:
    auth_signals_verified: object
    list_hygiene_metrics: object
    content_risk_flags: [string]
    policy_thresholds_applied: object
  decision_refusal:
    reason: string | null
```

The verdict fails closed: when a signal or metric is missing, the verdict
sets `preflight_clear: false`, lists the missing input as a blocker, and
does not invent a missing value.

## Inputs

```yaml
campaign_draft:
  from: string
  subject: string
  content_digest: string
list_metadata:
  size: number
  bounce_rate: number
  complaint_rate: number
  freshness_days: number
sender_auth_posture:
  spf_pass: bool
  dkim_pass: bool
  dmarc_pass: bool
  warm_up_days: number
```

## Outputs

```yaml
send_risk_verdict:
  risk_level: pass | hold | block
  preflight_clear: bool
  blockers: [string]
  evidence_summary:
    auth_signals_verified:
      spf_pass: bool
      dkim_pass: bool
      dmarc_pass: bool
      warm_up_days: number
    list_hygiene_metrics:
      size: number
      bounce_rate: number
      complaint_rate: number
      freshness_days: number
    content_risk_flags: [string]
    policy_thresholds_applied:
      bounce_rate_max: 0.05
      complaint_rate_max: 0.001
      freshness_days_max: 30
  decision_refusal:
    reason: string | null
```

The verdict binds into `send-as` preflight checks and blockers, where a
non-clear verdict prevents `send-as` from satisfying its preflight and
forces human approval. The `public_send` Effect belongs to `send-as`,
never to this skill, which delivers no message and never executes the
send.

## Verification

Two harness cases pin the verdict:

1. `low-risk-verified-sender`: a verified sender with clean list signals
   and full authentication yields
   `risk_level: pass`, `preflight_clear: true`, `blockers: []`.
2. `high-risk-incomplete-auth-poor-list`: DKIM does not pass and bounce
   rate exceeds policy, yielding
   `risk_level: hold`, `preflight_clear: false`, `blockers: [...]` with
   no preflight clearance and a `needs_human` escalation.

The hosted registry harness reads only these two cases.

## Public value

Operators use `spam-risk-reviewer` as the pre-send gate for any campaign
whose authority they care about. A real user can install the skill with
`runx add jdjioe5-cpu/spam-risk-reviewer@<version>`, run it on any
campaign draft, and read the verdict into their downstream `send-as`
preflight check. The judgment never replaces a human approval lane; it
fails closed and refuses to clear preflight for any input that does not
explicitly clear all three auth signals and all three hygiene metrics.
