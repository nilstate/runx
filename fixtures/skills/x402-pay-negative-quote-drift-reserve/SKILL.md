---
name: pay-reserve
description: Emit a quote-drift x402 reservation for authority-admission refusal.
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
      payment_reservation_packet: runx.payment.payment_reservation_packet.v1
---

# x402 Pay Negative Quote Drift Reserve

Emit a deterministic reservation packet for the x402 quote-drift fixture. The
reserved child authority stays a valid subset of the parent and reserves the
quoted `125` minor-unit spend, but the spend capability binding drifts upward to
`175`. Native authority admission must reject the binding before rail
fulfillment can expose mock credential or rail material.
