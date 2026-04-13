---
name: bug-to-pr
description: Compatibility alias for the canonical issue-to-pr official skill.
---

# Bug to PR

`bug-to-pr` remains available as a compatibility entrypoint for existing
callers, but the canonical official skill name is now `issue-to-pr`.

Use `issue-to-pr` for new workflows and documentation. The old name is a thin
wrapper that forwards the same governed lane and keeps existing callers working
while the rest of the ecosystem updates its naming.

## Canonical Skill

- Preferred: `runx issue-to-pr ...`
- Alias: `runx bug-to-pr ...`

The execution model is unchanged: scafld governs spec creation, approval,
execution, audit, review, and completion, while deterministic write phases keep
the mutation boundary explicit.
