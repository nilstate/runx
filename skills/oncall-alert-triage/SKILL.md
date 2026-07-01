---
name: oncall-alert-triage
description: Judge one on-call alert against a sealed runbook and policy, then emit a bounded triage packet for downstream governed lanes.
runx:
  category: ops
---

# On-call Alert Triage

`oncall-alert-triage` decides whether an alert should be acknowledged,
escalated, auto-remediated, suppressed, or stopped for a human. It is a
read-only judgment skill: it never pages a person, opens an incident PR, posts a
review note, mints authority, or executes a remediation step.

The useful output is a single `runx.oncall.triage.v1` packet. A downstream
driver or operator may later route that packet to separate governed runs, such
as a live page, an incident PR package behind a human merge gate, or a
`pr-review-note` comment body. Those effects stay outside this skill.

## What This Skill Does

The skill reads three pieces of evidence:

- `alert{id, service, severity, signal}`
- `runbook_ref`, including a sealed digest and target bindings
- `oncall_policy{services, escalation_rules}`

It verifies that the service is in policy, the runbook is sealed, and the
runbook or policy binds the targets needed for any packet. When the alert is
eligible for escalation or auto-remediation, it emits one packet that names the
page target, incident PR target, PR review note body, optional fix bundle, and
escalation route. When the evidence is missing or unsafe, it stops with
`needs_agent` or returns a refusal instead of inventing a target.

## When To Use It

- An operator has an alert and needs a receipt-backed triage decision before
  dispatching any live on-call effect.
- A workflow needs to prove which runbook digest and policy clause justified an
  escalation packet.
- A run should separate judgment from action, so humans can review the packet
  before paging or opening an incident PR.

## When Not To Use It

- To actually page, send, comment, open a PR, or remediate. Use downstream
  governed lanes for those effects.
- To triage a service that is absent from `oncall_policy`.
- To make up missing runbook steps, escalation targets, incident PR targets, or
  fix bundles.
- To clear an unsealed runbook or ambiguous alert without human review.

## Procedure

1. Read the alert and record `id`, `service`, `severity`, and `signal`.
2. Confirm `service` appears in `oncall_policy.services`.
3. Confirm `runbook_ref.sealed` is true and a digest is present.
4. Resolve the escalation rule for the service.
5. If escalation or remediation is allowed, bind both `page_target` and
   `incident_pr_target`.
6. Emit a single `decision` and, only for `escalate` or `auto_remediate`, one
   `runx.oncall.triage.v1` packet.
7. Stop when any target, policy clause, or sealed runbook evidence is missing.

## Output Contract

```yaml
decision:
  action: acknowledge | escalate | auto_remediate | suppress
  reason: string
triage_packet:
  schema: runx.oncall.triage.v1
  page_target: string
  incident_pr_target: string
  pr_review_note_body: string
  fix_bundle: object | null
  escalation: string
  evidence:
    alert_id: string
    service: string
    runbook_digest: string
    policy_clause: string
refusal:
  reason: string | null
```

`triage_packet` is emitted only when the action is `escalate` or
`auto_remediate` and all targets are bound. A suppressed or acknowledged alert
may return only the `decision`. Missing evidence stops the run instead of
producing a packet.

## Harness Cases

The harness covers two cases:

- `oncall-alert-triage-escalate-sealed`: a page-severity `checkout-api` alert
  with a sealed runbook and in-policy service emits one
  `runx.oncall.triage.v1` packet and seals.
- `oncall-alert-triage-missing-runbook-needs-agent`: a service without a
  declared policy and without a sealed runbook omits caller answers, blocks at
  the agent task, emits no packet, and returns `needs_agent`.

## Evidence Requirements

Evidence should include the runx CLI version, package name and version,
registry reference, public URL, source URL, PR URL, raw `X.yaml`, raw
`SKILL.md`, harness case names, hosted harness status, dogfood command, receipt
reference, verification result, the runbook digest, policy clause, packet
target fields, and stop reason.
