---
name: pay-recover
description: Reconcile an idempotent payment attempt before retrying or sealing.
runx:
  category: payments
---

# Pay Recover

Inspect a payment idempotency key after a crash, timeout, retry, or ambiguous
rail response.

This skill is the recovery surface for agent payments. It answers one question:
has this reserved payment already reached a rail outcome that can be sealed, or
is a retry still safe? It must prefer reconciliation over mutation.

It does not spend. It does not decide success without a proof ref. It reports
ambiguous states as escalation.

Tie every conclusion to the reservation decision, idempotency key, rail
profile, and proof references. The safe outcomes are deliberately narrow: seal
recovered proof, retry once under the same key, decline, or escalate. If the
rail cannot prove success, failure, or a safe same-key retry, return `escalate`.

## Output

- `recovery_assessment`: recovered, retry_safe, failed, or ambiguous.
- `rail_lookup`: what was queried and which idempotency key was used.
- `proof_refs`: recovered rail proof refs, if any.
- `recommended_action`: seal, retry_same_key, decline, or escalate.
- `open_questions`: unresolved state that blocks safe execution.

## Inputs

- `idempotency` (required): reservation key and recovery lookup fields.
- `reserved_payment_authority` (required): child payment authority term.
- `rail_profile_ref` (required): configured rail profile reference.
- `prior_rail_result` (optional): previous rail attempt result.
- `receipt_refs` (optional): existing harness or rail proof refs.
