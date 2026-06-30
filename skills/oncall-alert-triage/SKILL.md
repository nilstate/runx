---
name: oncall-alert-triage
description: Triage a sealed runbook-backed pager alert into acknowledge, escalate, auto_remediate, or suppress without paging or mutating state.
source:
  type: cli-tool
  command: node
  args:
    - run.mjs
  timeout_seconds: 30
  sandbox:
    profile: readonly
    cwd_policy: skill-directory
    require_enforcement: false
inputs:
  alert:
    type: json
    required: true
    description: Alert object with id, service, severity, and signal.
  runbook_ref:
    type: json
    required: true
    description: Sealed runbook reference with digest and bounded operator targets.
  oncall_policy:
    type: json
    required: true
    description: Declared services and escalation rules that constrain triage.
runx:
  category: ops
  input_resolution:
    required:
      - alert
      - runbook_ref
      - oncall_policy
---

# Oncall Alert Triage

`oncall-alert-triage` is a read-only judgment for pager alert intake. It reads
an alert, a sealed runbook reference, and the declared oncall policy for the
service, then classifies the alert into `acknowledge`, `escalate`,
`auto_remediate`, or `suppress`.

When escalation or auto-remediation is eligible, the skill emits exactly one
`runx.oncall.triage.v1` packet containing the page target, incident-PR target,
and PR review note body. That packet is not consumed here. A downstream
operator dispatches by naming separate governed runs:

- a live page send run,
- an `issue-to-pr` incident PR lane behind a human merge gate,
- and a `pr-review-note` lane for the comment body.

The skill never pages, opens a PR, applies a fix, mints authority, or emits an
`AttenuationRequest`.

## Decision rules

- Refuse any alert whose `service` is not declared in
  `oncall_policy.services`.
- Refuse missing or unsealed runbooks; the stop path seals a receipt with no
  packet.
- Refuse escalation or auto-remediation when either `page_target` or
  `incident_pr_target` cannot be bound from policy or sealed runbook evidence.
- Never invent remediation steps or escalation paths absent from the sealed
  runbook and policy.
- Apply the first matching policy rule by service, severity, and optional signal
  match. Default to `acknowledge` only when the service is declared and the
  runbook is sealed but no escalation rule matches.

## Verification

Local harness:

```bash
runx harness ./skills/oncall-alert-triage --json
```

Dogfood fixture run:

```bash
runx skill ./skills/oncall-alert-triage --json \
  --input-json alert=@fixtures/escalate-alert.json \
  --input-json runbook_ref=@fixtures/sealed-runbook.json \
  --input-json oncall_policy=@fixtures/oncall-policy.json
```

