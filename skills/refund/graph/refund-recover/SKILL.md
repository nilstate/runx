---
name: refund-recover
description: Inspect an ambiguous refund idempotency key and recommend a terminal action.
runx:
  category: payments
---

# Refund Recover

Reconcile a refund idempotency key after timeout, crash, retry, or ambiguous
settlement state.

This skill is profile-only. It reports whether a prior refund attempt appears
mutated, pending, declined, safely retryable, or escalated. It does not repair
durable receipt state or issue another rail mutation.

Key every lookup and recommendation by both the original receipt reference and
refund idempotency key. Return the supporting proof references with recovered
or declined outcomes. If the rail lookup or proof is incomplete, return
`escalated`; never turn ambiguity into success or recommend a fresh mutation.

## Output

- `recovery_assessment`: recovered, pending, declined, retry-safe, or escalated.
- `refund_lookup`: family lookup performed under the original idempotency key.
- `proof_refs`: existing settlement and receipt evidence.
- `recommended_action`: seal, wait, retry the same key, decline, or escalate.
- `open_questions`: evidence still needed before a terminal action.

## Inputs

- `original_receipt_ref` (required): linked sealed charge receipt reference.
- `refund_idempotency` (required): refund key and replay metadata.
- `settlement_family` (required): original receipt settlement family.
- `prior_refund_attempt` (optional): prior rail attempt summary.
- `receipt_refs` (optional): existing receipt or proof refs.
