---
name: dunning-ladder
version: 0.1.0
description: Choose the next bounded accounts-receivable reminder step, propose a gated send, and escalate instead of exceeding the cadence cap.
source:
  type: cli-tool
  command: node
  args:
    - run.mjs
links:
  source: https://github.com/luismireles12/runx/tree/feat/dunning-ladder/skills/dunning-ladder
runx:
  category: ops
---

# Dunning Ladder

`dunning-ladder` evaluates one overdue receivable against a supplied cadence
policy. It chooses the eligible next reminder step while below the hard cap and
emits a gated proposal for `send-as`. It sends nothing itself.

## Inputs

- `invoice_status`: invoice ID, current status, reminders already sent, and an
  optional non-sensitive customer reference.
- `aging_days`: whole days overdue.
- `cadence_policy`: ordered `steps` and a hard `cap`.

Each step supplies `step`, `min_days`, `channel`, and `template`.

## Outputs

- `decision`: chosen step and proposed action.
- `reminder_proposal`: channel, template, content digest, and mandatory approval
  gate.
- `escalation`: whether operator escalation is needed and why.

## Guardrails

- Refuse records that are not explicitly overdue.
- Never propose more reminders than the cadence cap.
- At the cap, fail the run with an escalation instruction and no proposal.
- Never send, post, charge, suspend service, or mutate the receivable.
- Do not include private contact or payment details in the output.
- A separate governed `send-as` run must approve and perform any reminder.

The skill gives finance operators a deterministic cadence decision while
preventing unbounded or duplicate nagging.

