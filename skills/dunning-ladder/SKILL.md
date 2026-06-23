---
name: dunning-ladder
description: Decide the next accounts-receivable reminder step within a capped cadence and emit a gated reminder proposal.
runx:
  category: finance
---

# Dunning Ladder

Plan the next reminder in an accounts-receivable dunning cadence without
sending the reminder directly.

This skill reads an overdue invoice state and a cadence policy. It chooses the
next allowed reminder step when the account is still within the cap, or
escalates when the cap has been reached. The reminder is only a gated proposed
effect for the `send-as` catalog skill.

## What this skill does

- Confirms the invoice is actually overdue from the supplied status and aging.
- Reads the policy cap and reminder steps supplied by the operator.
- Chooses the next reminder step without exceeding the cap.
- Emits a `reminder_proposal` with a channel and content digest for `send-as`.
- Escalates to the configured lane once the cadence cap is reached.

## When to use this skill

- An AR operator needs a bounded next action for an overdue invoice.
- A workflow needs to propose a reminder while keeping sending behind a
  separate approval gate.
- A customer has already received some reminders and the workflow must avoid
  unbounded follow-up.

## When not to use this skill

- To send the reminder itself.
- To dun an invoice that is paid, void, disputed, or not yet overdue.
- To invent cadence rules that are absent from `cadence_policy`.
- To exceed the reminder cap because a balance remains unpaid.

## Procedure

1. Validate `invoice_status`, `aging_days`, and `cadence_policy`.
2. Refuse if `invoice_status.status` is not `overdue` or `aging_days` is less
   than one.
3. Count prior reminders from `invoice_status.reminders_sent`.
4. If prior reminders are greater than or equal to `cadence_policy.cap`, set
   `decision.action` to `escalate`, emit no reminder proposal, and route to
   `cadence_policy.escalation_lane`.
5. Otherwise choose the next step whose `step` is one greater than the number
   of reminders already sent.
6. Refuse or escalate if the next step is missing or the invoice is too young
   for that step's `min_aging_days`.
7. Emit `reminder_proposal` as a gated proposed effect performed by `send-as`.

## Edge cases and stop conditions

- Paid, void, disputed, or pending invoices return `refused` with no reminder
  content.
- Missing or empty cadence steps return `refused`; do not invent steps.
- A missing next step escalates to the configured lane because the policy is
  incomplete.
- A too-young invoice for the next step returns `refused` and preserves the
  cap state for audit.
- At or above the cap, emit no reminder content and route to escalation.
- Any request to send, retry, or bypass approval remains a gated proposal only.

## Output schema

```yaml
decision:
  status: proposed | escalated | refused
  step: number | null
  action: propose_reminder | escalate | refuse
  reasons: [string]
reminder_proposal:
  effect: send-as
  gated: true
  channel: string | null
  content_digest: string | null
  recipient_ref: string | null
  invoice_ref: string | null
  amount_due: number | null
  currency: string | null
escalation:
  required: boolean
  lane: string | null
  reason: string | null
  cap: number
  reminders_sent: number
```

## Worked example

Input:

```yaml
invoice_status:
  invoice_id: inv-2026-0601
  status: overdue
  amount_due: 1840
  currency: USD
  customer_ref: acct-acme-legal
  reminders_sent: 1
aging_days: 22
cadence_policy:
  cap: 3
  escalation_lane: ar-manager
  steps:
    - step: 1
      min_aging_days: 7
      channel: email
      content_digest: first-notice-template
    - step: 2
      min_aging_days: 14
      channel: email
      content_digest: second-notice-template
```

Output:

```yaml
decision:
  status: proposed
  step: 2
  action: propose_reminder
reminder_proposal:
  effect: send-as
  gated: true
  channel: email
  content_digest: second-notice-template
escalation:
  required: false
```

## Inputs

- `invoice_status`: JSON object with `invoice_id`, `status`, optional
  `amount_due`, optional `currency`, `customer_ref`, and `reminders_sent`.
- `aging_days`: number of days past due.
- `cadence_policy`: JSON object with `cap`, `escalation_lane`, and ordered
  `steps`.

Each cadence step should include:

```yaml
step: 2
min_aging_days: 14
channel: email
content_digest: second-notice-template
```

## Output

Return JSON containing:

- `decision`: whether the skill proposed a reminder, escalated, or refused.
- `reminder_proposal`: a gated `send-as` proposal when the next step is allowed.
- `escalation`: cap state, lane, and reason when escalation is required.

## Safety rules

- Never send a reminder directly.
- Never exceed `cadence_policy.cap`.
- Never dun a record that is not overdue per the inputs.
- Keep the proposal gated behind `send-as`.
- Escalate rather than proposing another reminder at the cap.
- Do not include raw payment account numbers or secrets in the proposal.

## Local verification

Run:

```sh
node test.mjs
```

The test covers a within-cap reminder proposal, a cap-reached escalation, and a
not-overdue refusal.
