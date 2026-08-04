---
name: governed-outbound
description: Fetch one allowlisted external source, scrub personal data, obtain human authorization for the exact safe plan, and seal a provider-neutral outbound handoff without claiming delivery. Use when external content must cross a trust boundary through a separate delivery adapter.
---

# Governed Outbound

Prepare an exact outbound handoff in this order:

1. `web-fetch` performs the bounded provider read and returns source readback.
2. `redact-pii` detects semantic identifiers, deterministically scrubs the content, and withholds residual content unless its final verdict is `ready`.
3. The approval gate runs only for a ready redaction result. It authorizes this exact downstream plan; it does not send anything.
4. `send-as` plans principal, audience, provider lane, and the redacted digest.
5. A deterministic finalizer verifies the source evidence, redaction verdict, approval, principal, audience, content digest, and plan-only completion. The Runx graph receipt seals the chain.

The delivery adapter remains separate. This skill never claims a message was sent or delivered, and it does not use `sign-receipt` to manufacture a second attestation for work Runx already receipts.

## Composes

<!-- Generated from the native execution closure; run pnpm core-skills:composes:generate. -->

- `redact-pii#redact-pii`
- `send-as#plan`
- `web-fetch#web-fetch`

## Stop conditions

- Missing or disallowed fetch inputs stop in `web-fetch`.
- `needs_review` or `blocked` redaction skips approval and planning.
- Denied or absent approval skips planning.
- A send plan whose principal, audience, or digest differs from the approved redaction fails deterministic finalization.
- Provider execution and readback must occur in the selected downstream adapter before any caller reports delivery.

## Output

`outbound_plan` records `completion: plan_only`, `provider_delivery: not_executed`, source and redaction digests, the approval reference, the bounded send plan, and the selected provider actions. The scrubbed content remains available only in the redaction step output for the authorized downstream adapter.

Inputs are `url`, `allowlist`, `channel`, `principal`, and optional `operator_context`.
