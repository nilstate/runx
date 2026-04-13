---
name: github-triage
description: Discover, analyze, and draft high-signal GitHub issue responses and follow-up actions.
---

# GitHub Triage

Turn noisy issue streams into bounded, evidence-backed action.

This skill is for issue selection and response drafting, not for silently
mutating repositories. Use it to identify which threads are worth attention,
understand the maintainer or contributor situation, and draft the next helpful
response or remediation path.

Separate discovery from response. Discovery finds the thread worth engaging.
Response drafting turns one chosen thread into a concrete answer, escalation,
or change plan.

## Output

Discovery runner:

- `issue_candidates`: candidate issues or discussions worth attention.
- `selection_rationale`: why one candidate should be handled next.
- `operator_notes`: constraints, caveats, or escalation triggers.

Response runner:

- `issue_profile`: concise summary of the chosen thread.
- `response_strategy`: recommended response posture and next action.
- `response_draft`: post-ready draft or maintainer handoff.
- `follow_up_actions`: concrete next steps after the response.

## Inputs

- `repository` (optional): repository slug or workspace reference.
- `query` (optional): search or queue objective for discovery.
- `issue_url` (optional): canonical issue URL for response drafting.
- `issue_snapshot` (optional): structured issue data when already fetched.
- `maintainer_context` (optional): project norms, release posture, and
  response constraints.
- `operator_context` (optional): compatibility alias for maintainer or
  operator context used by higher-level triage chains.
- `objective` (optional): what the operator wants from this pass.
