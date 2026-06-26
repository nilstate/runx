---
name: oncall-alert-triage
description: Classify a sealed on-call alert into a read-only triage packet for downstream incident lanes.
runx:
  category: ops
---

# Oncall Alert Triage

## What this skill does

Classify one pager alert against a sealed runbook and service on-call policy.
When the alert is eligible for downstream action, emit exactly one
`runx.oncall.triage.v1` packet that names the action, sealed runbook digest,
policy clauses applied, page target, incident PR target, and review-note body.

The skill performs a thin `review` act only. It never pages anyone, opens a PR,
posts a comment, applies a fix, mints authority, or runs a downstream lane.
Downstream drivers may consume the packet by name under their own authority,
gate, and receipt policy.

## When to use this skill

Use this skill when an operator or governed workflow has:

- a pager alert with `id`, `service`, `severity`, and `signal`;
- a runbook reference with a seal state and digest;
- an on-call policy declaring the service and escalation rules;
- an operator-safe `source_url` for provenance; and
- a need to separate triage judgment from page, PR, comment, or remediation
  effects.

## When not to use this skill

Do not use this skill to execute incident effects. Do not use it when the
service is undeclared, the runbook is missing or unsealed, a page target or
incident PR target cannot be bound for an eligible action, the requested action
is outside policy, or the alert cannot be tied to the provided source.

Return `needs_agent` rather than a packet when evidence is incomplete or unsafe.

## Procedure

1. Confirm the alert is tied to `source_url` and includes `id`, `service`,
   `severity`, and `signal`.
2. Confirm `oncall_policy.services` declares the alert service.
3. Confirm `runbook_ref.sealed` is true and `runbook_ref.digest` is present.
4. Match the alert to one policy clause and choose exactly one action:
   `acknowledge`, `escalate`, `auto_remediate`, or `suppress`.
5. For `escalate` or `auto_remediate`, bind both `page_target` and
   `incident_pr_target` before emitting a packet.
6. Record the sealed runbook digest in `decision.reason`,
   `triage_packet.runbook.digest`, and
   `evidence_json.observations.sealed_runbook_digest`.
7. Return `decision`, `escalation`, `triage_packet`, `evidence_json`,
   `verification_json`, `report`, and `reason`.

## Edge cases and stop conditions

- Unknown service: return `needs_agent` and do not emit a packet.
- Missing or unsealed runbook: return `needs_agent` and do not emit a packet.
- Missing page target or incident PR target for `escalate` or
  `auto_remediate`: return `needs_agent`.
- Suppressed or acknowledged alert: return the decision and evidence, but do
  not emit a dispatch packet.
- Attempted page, PR, comment, fix, authority mint, `AttenuationRequest`, or
  nested downstream execution: return `needs_agent`.
- Credential, token, private URL, raw pager secret, or contact identity data in
  inputs: refuse to include it in output and stop for agent review.

## Output schema

Return a `triage_packet` only for `escalate` or `auto_remediate`:

```json
{
  "schema": "runx.oncall.triage.v1",
  "alert": {
    "id": "alert-123",
    "service": "checkout-api",
    "severity": "sev2",
    "signal": "5xx burn rate above policy"
  },
  "decision": {
    "action": "escalate",
    "reason": "checkout-api sev2 burn rate matches policy clause sev2-escalate and runbook digest sha256:..."
  },
  "runbook": {
    "ref": "runbook://checkout-api/5xx-burn",
    "digest": "sha256:..."
  },
  "policy_clauses_applied": ["sev2-escalate"],
  "packet": {
    "page_target": "oncall://payments-primary",
    "incident_pr_target": "github://runxhq/runx/incidents/checkout-api-alert-123",
    "pr_review_note_body": "Escalate checkout-api alert alert-123: sev2 burn rate over policy; sealed runbook sha256:...",
    "fix_bundle": null
  },
  "dispatch": {
    "mode": "by_name",
    "downstream_runs": ["issue-to-pr", "pr-review-note", "send-as"]
  }
}
```

Also return:

- `decision`: object with `action` and `reason`.
- `escalation`: object naming the field, target, incident PR target, and human
  gate when applicable.
- `evidence_json`: machine-checkable observations including source URL, exact
  alert fields, sealed runbook digest, policy clauses, harness case names,
  receipt id when available, and inferred targets.
- `verification_json`: checks for package name, no authority minted, no effect
  executed, packet emission, and packet schema.
- `report`: concise operator-facing summary.
- `reason`: the receipt reason string.

## Worked example

An alert for `checkout-api` reports a `sev2` 5xx burn-rate signal. The service
policy has clause `sev2-escalate`, and the sealed runbook digest is
`sha256:6aaf...1a34`. Because both `oncall://payments-primary` and the incident
PR target are bound, the skill returns `decision.action: escalate`, emits a
`runx.oncall.triage.v1` packet, and reports that no page, PR, comment, or
remediation was executed by this review-only run.

If the same alert lacks a sealed runbook or uses an undeclared service, the
skill returns `needs_agent` and emits no packet.

## Inputs

- `alert`: object with `id`, `service`, `severity`, and `signal`.
- `runbook_ref`: object naming the runbook locator, `sealed` boolean, digest,
  and any allowed remediation notes or bounded targets.
- `oncall_policy`: object with declared services and escalation rules.
- `source_url`: public or operator-safe URL for alert provenance.
- Optional act metadata: `target_ref`, `authority_ref`, `actor_ref`,
  `previous_receipt_ref`, and `act_decision`.
