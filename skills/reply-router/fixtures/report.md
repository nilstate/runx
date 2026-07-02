# reply-router bounty report

## Summary

`reply-router` is a public runx skill package for deterministic inbound-reply
routing. It accepts an inbound reply, the original send receipt, and a caller
suppression policy. It never sends mail directly.

## Behavior

- Sealed unsubscribe replies emit a `runx.data.operation_result.v1`
  `append_event` shape for `registry:runx/data-store@0.1.2`.
- Ambiguous replies or unsealed original-send receipts stop with
  `decision: needs_agent` and do not emit suppression writes or send routes.
- Grounded non-suppression replies emit a bounded `runx.reply.routing.v1`
  decision for a later governed `send-as` workflow.
- Suppression writes use a recipient-keyed aggregate, expected-version CAS, and
  a deterministic idempotency key.

## Verification

- `runx-cli 0.6.14` ran the inline harness with two cases.
- Harness status: `passed`, `case_count=2`, `assertion_error_count=0`.
- Dogfood run produced an unsubscribe suppression packet with no routing
  decision and no direct send.
- Dogfood receipt verified as valid:
  `sha256:b6c3efcfe7b8a4ca9f90a44971968626174683332997ce37847489afa4a8565d`.
- Local registry publish produced `chico10117/reply-router@0.1.0`.

## Artifacts

- Skill package: `skills/reply-router`.
- Harness evidence: `fixtures/harness-evidence.json`.
- Verification summary: `fixtures/verification.json`.
- Receipt ref:
  `runx:receipt:sha256:b6c3efcfe7b8a4ca9f90a44971968626174683332997ce37847489afa4a8565d`.
