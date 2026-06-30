# reply-router Frantic #70 report

## Summary

`reply-router` classifies inbound replies to previously sealed sends without sending any follow-up message itself.

It handles three safe lanes:

- unsubscribe replies are recorded as recipient-keyed suppression events through a data-store compare-and-set append
- interested replies emit a typed `runx.reply.routing.v1` routing decision for a later governed sender
- ambiguous or unsealed replies stop for human review instead of mutating state

## Published package

- Package: `rohitmulani63-ops/reply-router@sha-a3bebc6`
- Public URL: https://runx.ai/x/rohitmulani63-ops/reply-router
- PR: https://github.com/runxhq/runx/pull/187

## Local harness

- Command: `runx harness ./skills/reply-router`
- Environment: Docker Linux with `runx-cli 0.6.14`
- Status: passed
- Cases: 3
- Assertion errors: 0

Covered cases:

- `sealed_unsubscribe_suppression`
- `sealed_interested_route`
- `stop_ambiguous_or_unsealed`

## Post-publish dogfood

- Command: `runx skill rohitmulani63-ops/reply-router@sha-a3bebc6 --registry https://api.runx.ai -R ./skills/reply-router/evidence/dogfood-receipts -j ...`
- Status: sealed
- Receipt: `runx:receipt:sha256:f342f3f02527ee8cf9a7ea4e8d297a4911121d93b1cbda096f0e5ed7a4901b51`

The dogfood input used a sealed original-send receipt, an unsubscribe reply, a suppression policy, and the local data store tool. The output classified the reply as `unsubscribe`, appended one suppression event, and read back the recipient projection at version 1.

## Verification

`runx verify` was run against the post-publish dogfood receipt with the demo verification key material configured through environment variables.

Result:

- `valid: true`
- digest status: `valid`
- content-address status: `valid`
- signature status: `valid`
- findings: `[]`

## Why this satisfies the bounty

- The skill is dispatch-free and never sends replies directly.
- Suppression writes are idempotent and recipient-keyed.
- Non-unsubscribe replies produce bounded routing decisions instead of side effects.
- Ambiguous or unsealed inputs stop safely.
- The submitted `evidence_json` includes the required `dogfood` block with package, input, command, post-publish receipt, verify verdict, and harness cases.