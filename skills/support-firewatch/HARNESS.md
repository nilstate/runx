# Support Firewatch Harness Evidence

This package uses the inline harness cases in `X.yaml` plus the JSON fixtures in `fixtures/`.

## Contract

- Inputs: `thread`, `sla_policy`
- Outputs: `signals{sentiment,sla_breach,churn_risk}` and `escalation{needed,priority,context}`
- Side effects: none; the runner does not page, reassign, notify, or mutate tickets.

## Local Verification

RunX CLI version used by the operator lane: `runx-cli 0.6.14`.

Local production-signed harness result:

```json
{
  "status": "passed",
  "case_count": 3,
  "assertion_error_count": 0,
  "case_names": [
    "support-firewatch-escalates-sla-and-churn-risk",
    "support-firewatch-healthy-thread-no-escalation",
    "support-firewatch-needs-required-inputs"
  ],
  "receipt_ids": [
    "sha256:4c68fec79e6aacea6e5fd0c998349009ee90d80af1f2cb912b0b70bcb9ae8f3e",
    "sha256:4a9797a6f6361bee90de7eb8c5b4bc94b11f0e5a2ddc28dad3fdfe59d5b3f607",
    "sha256:240656444f24cbaefbf3a3faaeabcb95785f62e81e84232df2697b7b9babe5d2"
  ]
}
```
