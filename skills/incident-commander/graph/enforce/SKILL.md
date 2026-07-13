---
name: incident-commander-enforce
description: Fail closed on invalid incident decisions, scopes, owners, approvals, communication handoffs, and closure evidence.
runx:
  category: ops
---

# Incident commander enforcement stage

Internal deterministic stage for `incident-commander`. It constructs the final
typed turn from allowlisted fields after validating the fixed roster, prior
pending turn, approval principal, plan-only handoff, dispatch scope, named owner,
and receipt-shaped closure evidence. It has no side effects.
