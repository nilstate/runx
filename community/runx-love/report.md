# Authentic RunX support action

- Public action: filed [runx resume leaves approval pending after supplied approval answer](https://github.com/runxhq/runx/issues/311).
- Project link: the report is filed directly in the public [runxhq/runx](https://github.com/runxhq/runx) repository.
- What it contributes: a deterministic reproduction of an approval-resume state transition that remains pending even after a supplied answer.
- Evidence depth: the report records RunX CLI 0.7.0, the exact catalog graph invocation, the resume commands, both documented answer payload shapes, and clean receipt directories.
- Expected behavior: a valid supplied approval should satisfy the pending gate and allow the graph to continue or fail with a specific validation error.
- Observed behavior: every documented input shape leaves the same approval pending without a targeted validation error.
- Audience: maintainers and contributors working on resume semantics, approval gates, or governed graph execution.
- Public access: both the issue and this supporting evidence are readable by a stranger without signing in.
- Venue fit: GitHub Issues is the repository's normal bug-reporting surface, and the post is a focused defect report rather than generic promotion or link spam.
- Authenticity: the defect was encountered while running a real governed validation for an upstream documentation task, then reproduced in isolated receipt directories before filing.
