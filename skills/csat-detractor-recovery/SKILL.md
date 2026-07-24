---
name: csat-detractor-recovery
version: 0.1.0
description: Turn a CSAT detractor survey plus account context into a bounded recovery packet. Reads feedback, csat_score, account_tier, and lifetime_value_usd, classifies severity, proposes a recovery path (apology_only, outreach, credit, escalation), and emits a typed csat recovery packet with rationale, owner, and stop conditions. Sends no email, issues no credit, opens no ticket.
source:
  type: cli-tool
  command: node
  args:
    - run.mjs
links:
  source: https://github.com/runxhq/runx/tree/main/skills/csat-detractor-recovery
runx:
  category: ops
  input_resolution:
    required:
      - feedback
      - csat_score
---

## What this skill does

Compose a bounded CSAT detractor recovery packet from a bounded survey and
account context. The runner emits `runx.csat.recovery.v1` with severity,
classification, recommended path (apology_only, outreach, credit, escalate),
rationale, owner_role, stop_conditions, and handoff pointer. It is a
deterministic local composer; it never sends email, issues credits, opens
support tickets, or mutates CRM state.

The skill proposes; a separate governed outbound skill can review, approve,
and emit authority grants before any external side effect runs.

## When to use this skill

Use this skill when an agent has a single CSAT detractor response with
account context and needs a calm first-pass recovery plan. It is useful in
post-response workflows, customer-success rotations, and periodic churn
reviews where the same bounded inputs need a bounded output every time.

It is intentionally read-only by design. It emits decisions; it never
enforces them.

## When not to use this skill

Do not use this skill to send apology emails, issue credits, refund
invoices, escalate to legal, or open support tickets. Do not use it as an
automatic churn predictor or to bypass a customer's own escalation path.
Do not use it to override a CSM's manual decision or to apply pricing
changes.

If `feedback` is empty or `csat_score` is missing, the skill refuses with
`needs_input`. If the account context carries private customer data that
has not been summarized, the skill refuses with `refused` rather than risk
a leak through its output.

## Procedure

1. Require `feedback` to be non-empty text and `csat_score` to be an
   integer from 0 to 10.
2. Accept optional `account_tier` (`free`, `starter`, `growth`, `enterprise`),
   `lifetime_value_usd` (number), and `prior_complaints` (number).
3. Normalize feedback: cap length, drop empty, classify sentiment hint from
   keywords (`refund`, `bug`, `price`, `slow`, `support`) without storing
   the raw text beyond the truncated echo.
4. Compute severity from `csat_score` and `lifetime_value_usd`:
   `score <= 2 && ltv >= 1000` -> escalate; `score <= 4` -> credit;
   `score <= 6` -> outreach; else -> apology_only.
5. Compose recovery packet with rationale that references the score and the
   bounded inputs only.
6. Emit `runx.csat.recovery.v1` packet and meta block.

## Edge cases and stop conditions

Return `needs_input` when feedback is empty or score is missing. Return
`refused` when account context carries private customer data not previously
summarized. Never invent account tier or LTV. Never propose a path that
exceeds the highest severity present in the input.

Authority scope is recovery packet composition only. The proof surface is
the sealed packet with severity, recommended_path, rationale, owner_role,
stop_conditions, and handoff envelope. Any live email, credit issuance, or
ticket creation requires a separate governed outbound skill.

## Output schema

The runner emits `runx.csat.recovery.v1`:

```json
{
  "severity": "low | medium | high | critical",
  "classification": "product | price | support | bug | other",
  "recommended_path": "apology_only | outreach | credit | escalate",
  "rationale": "score=2; ltv_usd=2400; prior_complaints=1; matched_signals=refund,bug",
  "owner_role": "cs_manager | csm_lead | support_lead | founder",
  "stop_conditions": [
    "no_resolution_within_72h",
    "customer_requests_refund_or_cancel"
  ],
  "handoff": {
    "next_skill": "governed-outbound",
    "requires_human_approval": true
  }
}
```

## Worked example

```bash
runx skill "$PWD" \
  --runner recover \
  --input-json feedback='App crashes every time I open settings. Considering refund.' \
  --input-json csat_score=2 \
  --input-json account_tier='growth' \
  --input-json lifetime_value_usd=2400 \
  --input-json prior_complaints=1 \
  --json
```

Expected result: `severity = critical`, `recommended_path = escalate`,
`owner_role = founder`, `stop_conditions` includes
`customer_requests_refund_or_cancel`. The run does not send any email,
issue any credit, or open any ticket.

## Inputs

- `feedback`: non-empty text of the detractor response.
- `csat_score`: integer 0..10.
- `account_tier`: optional tier hint.
- `lifetime_value_usd`: optional account lifetime value.
- `prior_complaints`: optional count of prior complaints.

## Outputs

- `severity`: bounded severity derived from score and LTV.
- `classification`: bounded topic classifier from feedback keywords.
- `recommended_path`: bounded first-pass recovery posture.
- `rationale`: traceable rationale from inputs only.
- `owner_role`: bounded owner role.
- `stop_conditions`: bounded escalation triggers.
- `handoff`: pointer to the next governed skill.