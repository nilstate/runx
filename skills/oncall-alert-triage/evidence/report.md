# Oncall Alert Triage — Evidence Report

## What was built

A read-only runx skill that triages oncall alerts by reading sealed alert data, runbook references, and oncall policy to produce a triage decision and packet.

## Why it's trustworthy

- **Read-only**: Mints no authority, holds no state, emits no Effect
- **Grounded decisions**: Every triage decision is tied to sealed alert data, runbook, and policy
- **Safe escalation**: Missing runbooks and undeclared services escalate to needs_agent
- **No invented paths**: The skill never fabricates remediation steps or escalation paths
- **Sealed receipts**: Both harness cases produce sealed receipts with Ed25519 signatures

## How to install, run, and verify

### Install
```bash
runx add deltah9420/oncall-alert-triage@0.1.0 --registry https://api.runx.ai
```

### Run (escalate example)
```bash
runx skill deltah9420/oncall-alert-triage@0.1.0 --registry https://api.runx.ai \
  --input alert='{"id":"alert-001","service":"payments-api","severity":"critical","signal":"error_rate_spike"}' \
  --input runbook_ref='runbook:payments-api:error-rate' \
  --input oncall_policy='{"services":["payments-api","auth-service"],"escalation_rules":{"payments-api":{"severity_critical":"escalate"}}}' \
  --json
```

### Verify
```bash
runx verify --receipt <receipt.json> --json
```

## Harness results

| Case | Status | Description |
|------|--------|-------------|
| sealed_escalate_eligible_alert | sealed | Escalate-eligible alert → decision.escalate + packet |
| missing_runbook_stop | failure | Missing runbook → needs_agent, no packet |

## Dogfood result

- **Receipt ID**: `runx:receipt:sha256:e8cafe9aa3eeda864fddbe18f94b0774ac4ba7949075e8cd9a1ac5fd7e478070`
- **Decision**: escalate
- **Packet**: page_target=oncall:payments-api:critical, incident_pr_target=pr:payments-api:incident-alert-001
- **All validations**: service_in_policy=true, runbook_sealed=true, escalation_rule_found=true

## Key design decisions

1. **Missing runbook = needs_agent**: Empty or missing runbook_ref triggers escalation with no packet emitted.

2. **Undeclared service = needs_agent**: Services not in oncall_policy.services trigger escalation.

3. **No effect envelope**: The packet is read-only. Downstream dispatch (issue-to-pr, pr-review-note, live page) is by naming separate governed runs.

## Pending

- Maintainer approval for CI on the PR (new fork, workflows awaiting approval)
