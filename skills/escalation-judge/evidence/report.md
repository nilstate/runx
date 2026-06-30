# escalation-judge delivery report

This delivery implements and publishes the requested `escalation-judge` runx skill for bounty #69.

## Package

- Package: `escalation-judge`
- Registry ref: `vidshidden/escalation-judge@sha-8bdc1d12bfae`
- Public URL: https://runx.ai/x/vidshidden/escalation-judge@sha-8bdc1d12bfae
- runx CLI: `0.6.14`
- Hosted harness: https://runx.ai/x/vidshidden/escalation-judge#harness
- Harness status: passed, 3 cases
- Harness receipts: runx:receipt:sha256:71c23abd221652ff488e9e545ce411ab36605aec6a4f1efc4b9bcc2af534f7ef, runx:receipt:sha256:8b605d176674a703058c8f7fb924c1e56f8df76b512e0fb0473f91bb9e1cf998, runx:receipt:sha256:f8e09fe933182d016a274595e9380d67c168c6b0db96f3b9a5d42d65abfcdbdb

## Behavior

- `sealed_high_severity_escalation`: `sev1` crosses `severity:sev1`, reads prior projection version 3, appends `case_426f406dd768`, and emits a typed escalation packet naming `slack-notify` as the target rail. It does not send or post.
- `stop_no_threshold_no_change`: routine documentation request returns `decision.escalate=false`, no case id, no append event, no packet, and `no_change`.
- `ambiguous_low_confidence_needs_agent`: low-confidence triage stops with `stop_state.state=needs_human`; it does not infer a lane or create a case.

## Verification

- Hosted publish harness passed all three cases and produced sealed receipt refs listed above.
- Clean install passed with `runx add vidshidden/escalation-judge@sha-8bdc1d12bfae --registry https://api.runx.ai`.
- Windows local `runx skill` resolved trusted registry provenance but hit the known receipt-store `os error 87`; the raw output is committed as `dogfood-output-windows.json`.
- `.github/workflows/escalation-judge-dogfood.yml` reruns the same dogfood on Ubuntu and commits `dogfood-output.json`, `dogfood-verify.json`, and receipt files.
