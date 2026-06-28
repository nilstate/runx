---
name: pay-quote
description: Refuse a malformed x402 challenge without issuing a quote.
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
      payment_refusal_packet: runx.payment.payment_refusal_packet.v1
---

Emit a deterministic governed refusal for a malformed x402 challenge fixture.
