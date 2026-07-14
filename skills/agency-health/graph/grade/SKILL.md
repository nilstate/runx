---
name: agency-health-grade
description: Validate composed agency projection, event, and ledger evidence, then deterministically grade a typed read-only health verdict.
---

# Agency Health Grade

Internal deterministic stage for `agency-health`. It reconciles projection and
event order, folds the case, grades only signals with declared norms, and emits
grounded dispatch-by-naming findings. Missing or conflicting evidence produces
`needs_more_evidence`; this stage has no effect capability.
