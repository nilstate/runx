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
    "sha256:221c3e17dc25b98b4023c93024f8bd3eceddd84f8dda4a37c941ddf6afec7d9f",
    "sha256:ec64b2d406898e6a426cc628061eb13fe4d0f155cad495d817c168972d7c588e",
    "sha256:7a8441df58d1d66bc3f2efa201516bd15682bd2c31dc387cd899667571121765"
  ]
}
```
