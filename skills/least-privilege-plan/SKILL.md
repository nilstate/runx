---
name: least-privilege-plan
description: Convert grant history and observed effects into a reviewable least-privilege plan.
source:
  type: cli-tool
  command: node
  args:
    - run.mjs
runx:
  category: security
---

# Least-Privilege Plan

Read a bounded grant history packet and propose which scopes to keep, reduce,
revoke, or send to human review.

This skill does not change grants. It emits a plan for an operator or a later
governed grant-change lane.

## Procedure

1. Require `run_history_packet.grants`.
2. Compare each grant against `observed_effects`.
3. Keep grants that were used or explicitly required by policy.
4. Reduce wildcard grants when all observed effects fit one narrower scope.
5. Revoke unused grants that are not required by policy.
6. Defer unknown or unparsable scopes to human review.

## Inputs

- `run_history_packet`: grants and observed effects.
- `declared_policy`: policy id, required scopes, and review constraints.

## Outputs

- `keep`: justified grants.
- `reduce`: grants with narrower proposals.
- `revoke`: unused grants.
- `needs_human_review`: scopes with unknown semantics.
- `evidence`: policy digest, grant ids, observed effect counts, and unused scopes.

