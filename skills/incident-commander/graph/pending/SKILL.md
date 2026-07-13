---
name: incident-commander-pending
description: Materialize the non-executable awaiting-approval communication turn from a folded incident handoff.
runx:
  category: ops
---

# Incident commander pending stage

Internal deterministic stage for `incident-commander`. It validates a declared
pending communication and emits the digest-bound, non-executable
`awaiting_approval` turn. It does not authenticate approval or perform a send.
