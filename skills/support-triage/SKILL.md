---
name: support-triage
description: Turn a noisy support report into a bounded triage artifact and an explicit next runx lane.
---

# Support Triage

Convert an inbound issue, support request, or operator report into one explicit
triage decision.

This skill does not mutate code, open tickets, or publish replies directly. Its
job is to classify the report, summarize it, draft the next helpful response,
and recommend the next governed lane. That next lane must be explicit:
`issue-to-pr`, `objective-decompose`, `reply-only`, or `manual-triage`.

Use `issue-to-pr` only when the requested change is bounded enough for one
governed remediation lane. Use `objective-decompose` for larger or multi-step
work. Use `reply-only` when the right answer is guidance rather than mutation.
Use `manual-triage` when the report is ambiguous, risky, or missing key context.

## Output Contract

`triage_report` must contain:

- `category`: one of `bug`, `feature_request`, `docs`, `billing`, `account`,
  `question`, or `other`
- `severity`: one of `low`, `medium`, `high`, or `critical`
- `summary`: concise summary of the actual issue
- `suggested_reply`: a user-facing reply draft or operator handoff note
- `recommended_lane`: `issue-to-pr`, `objective-decompose`, `reply-only`, or
  `manual-triage`
- `rationale`: why that lane is the right next step
- `needs_human`: boolean
- `operator_notes`: array of caveats, missing context, or escalation notes

When `recommended_lane=issue-to-pr`, also include `issue_to_pr_request` with:

- `task_id`
- `issue_title`
- `issue_body`
- `source`
- `source_id`
- `source_url`
- `size`
- `risk`

When `recommended_lane=objective-decompose`, also include
`objective_request` with:

- `objective`
- `project_context`

Do not emit both `issue_to_pr_request` and `objective_request` for the same
report.

## Inputs

- `title` or `issue_title`: report title
- `body` or `issue_body`: report body
- `source`: source system such as `github_issue` or `support_request`
- `source_id`: source record id
- `source_url`: source URL
- `product_context` (optional): product-specific constraints or routing hints
- `operator_context` (optional): maintainer or support posture guidance
