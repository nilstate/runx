---
name: oncall-alert-triage
description: Read-only oncall alert triage that produces a decision and packet from sealed alert data, runbook, and policy.
source:
  type: cli-tool
  command: node
  args:
    - run.mjs
runx:
  tags:
    - oncall
    - triage
    - alerting
    - read-only
links:
  source: https://github.com/deltah9420/runx/tree/main/skills/oncall-alert-triage
---

## What this skill does

This skill reads a sealed alert, a runbook reference, and an oncall policy to
produce a triage decision (acknowledge, escalate, auto_remediate, or suppress)
and a `runx.oncall.triage.v1` packet containing page targets, incident PR
targets, and review note bodies.

The skill is read-only at the triage step. It mints no authority, holds no
state, and the packet is not consumed as an effect. Downstream dispatch
(issue-to-pr, pr-review-note, live page) is by naming separate governed runs
an operator dispatches.

## When to use this skill

Use this skill when an oncall alert arrives and you need a sealed, reproducible
triage decision. It is appropriate when the alert has a declared service in the
oncall policy and a sealed runbook is available for the signal.

The skill is especially useful upstream of paging and PR creation: it produces
a decision and packet that a human reviewer or downstream lane can inspect
before approving live actions.

## When not to use this skill

Do not use this skill when the runbook is missing or unsealed, when the service
is not declared in the oncall policy, or when you need a live page or PR
action. This skill never executes a page, creates a PR, or runs a remediation
— it only emits a decision and packet.

Do not use this skill to invent remediation steps or escalation paths absent
from the sealed runbook.

## Procedure

1. Read the `alert` input containing id, service, severity, and signal.
2. Validate that the service is declared in `oncall_policy.services`.
3. Read the `runbook_ref` and validate it is non-empty (sealed).
4. Look up the escalation rule for the service and severity.
5. If the runbook is missing or empty → escalate to needs_agent.
6. If the service is not in policy → refuse; escalate to needs_agent.
7. If escalation rule says escalate → emit decision.action=escalate with packet.
8. If escalation rule says acknowledge → emit decision.action=acknowledge (no packet).
9. Write `evidence.json` and `report.md` when `output_dir` is provided.

## Edge cases and stop conditions

Return `needs_input` when the `alert` input is missing. Return `refused` when
the caller asks the skill to execute a live page, create a PR, or run a
remediation.

Stop with an error when the alert lacks `id`, `service`, `severity`, or
`signal`, when the runbook_ref is empty (escalate to needs_agent), or when
the service is not declared in oncall_policy (escalate to needs_agent).

The skill never invents a remediation step or escalation path absent from the
sealed runbook. It refuses to emit a packet when no page or incident-PR target
can be bound.

## Output schema

The primary output is `oncall_triage_decision`, with schema
`oncall.triage.decision.v1`:

```json
{
  "schema": "oncall.triage.decision.v1",
  "data": {
    "decision": {
      "action": "acknowledge | escalate | auto_remediate | suppress",
      "reason": "string"
    },
    "alert": {
      "id": "string",
      "service": "string",
      "severity": "string",
      "signal": "string"
    },
    "runbook_ref": "string",
    "packet": {
      "schema": "runx.oncall.triage.v1",
      "page_target": "string",
      "incident_pr_target": "string",
      "pr_review_note_body": "string",
      "escalation": { ... }
    },
    "validation": {
      "valid": true,
      "service_in_policy": true,
      "runbook_sealed": true,
      "escalation_rule_found": true
    }
  }
}
```

When the runbook is missing or the service is out of policy, `packet` is null
and `decision.action` is `escalate` with a reason naming the issue.

## Inputs

- `alert`: alert object with id, service, severity, signal.
- `runbook_ref`: reference to the sealed runbook (empty = missing).
- `oncall_policy`: policy with services array and escalation_rules object.
- `output_dir`: optional directory for `evidence.json` and `report.md`.

## Outputs

- `oncall_triage_decision`: complete triage decision packet.
- `evidence_json`: same evidence as machine-checkable JSON.
- `report_md`: concise report with decision, alert details, and validation.
