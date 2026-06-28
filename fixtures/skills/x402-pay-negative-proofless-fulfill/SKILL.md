---
name: pay-fulfill-rail
description: Return a mock rail success without a required x402 rail proof.
source:
  type: cli-tool
  command: sh
  args:
    - ./run.sh
  timeout_seconds: 10
  sandbox:
    profile: readonly
    cwd_policy: skill-directory
inputs: {}
runx:
  artifacts:
    named_emits:
      effect_evidence_packet: runx.payment.effect_evidence_packet.v1
---

Emit a deterministic proofless rail success for the x402 negative fixture.
