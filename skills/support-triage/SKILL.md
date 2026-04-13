---
name: support-triage
description: Turn a noisy support report into a bounded triage artifact and an explicit next runx lane.
---

# Support Triage

Convert an inbound issue, support request, or operator report into one explicit
triage decision plus the parent change artifact that downstream planning or
mutation lanes must share.

This skill does not mutate code, open tickets, or publish replies directly. Its
job is to classify the report, summarize it, draft the next helpful response,
and recommend the next governed lane. That next lane must be explicit:
`issue-to-pr`, `objective-decompose`, `reply-only`, or `manual-triage`.

In supervisor-style flows, `support-triage` is also the commencement gate. It
decides whether work may start at all, whether the next step should stop at a
review comment first, and whether mutation is justified yet. A recommended lane
is not the same thing as build permission.

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

`triage_report` may also include supervisor-facing control fields:

- `commence_decision`: `approve`, `hold`, `reject`, or `needs_human`
- `action_decision`: `proceed_to_build`, `proceed_to_plan`,
  `request_review`, or `stop`
- `review_target`: `issue`, `draft_pr`, or `none`
- `review_comment`: markdown comment body for the supervisor to post before the
  next lane proceeds

When present, these fields mean:

- `commence_decision` gates whether the supervisor may start any downstream
  work at all
- `action_decision=proceed_to_plan` means the supervisor may open a planning
  lane such as `objective-decompose`, but still may not start repo mutation
- `action_decision=request_review` means the supervisor should post
  `review_comment` to the chosen `review_target` and stop there until a later
  approval or rerun authorizes mutation
- `recommended_lane=issue-to-pr` alone does **not** authorize a build lane

Always emit `change_set` alongside `triage_report`.

`change_set` must contain:

- `change_set_id`
- `source`: object with `type`, `id`, and optional `url`
- `summary`
- `category`
- `severity`
- `recommended_lane`
- `commence_decision`
- `action_decision`
- `target_surfaces`: array of objects with:
  - `surface`: repo, product surface, or bounded target name
  - `kind`: one of `repo`, `package`, `docs`, `support`, or `other`
  - `mutating`: boolean
  - `rationale`: why this surface is implicated
- `shared_invariants`: array of constraints that all downstream lanes must
  preserve
- `success_criteria`: array of concrete outcomes that define success for the
  whole change

The `change_set` is the parent artifact for any later planning or worker fanout.
It is what keeps multiple repo-scoped lanes aligned to one shared objective.

When `recommended_lane=issue-to-pr`, also include `issue_to_pr_request` with:

- `task_id`
- `issue_title`
- `issue_body`
- `source`
- `source_id`
- `source_url`
- `size`: one of `micro`, `small`, `medium`, or `large`
- `risk`: one of `low`, `medium`, or `high`

When `recommended_lane=objective-decompose`, also include
`workspace_change_plan_request` with:

- `change_set_id`
- `objective`
- `project_context`
- `target_surfaces`
- `shared_invariants`
- `success_criteria`

`objective_request` may still be emitted as a compatibility alias, but
`workspace_change_plan_request` is the canonical planning packet.

Do not emit both `issue_to_pr_request` and `workspace_change_plan_request` for
the same report.

Prefer conservative routing:

- if the report is bounded and well-understood, use `commence_decision=approve`
  and `action_decision=proceed_to_build`
- if the next step should be planning instead of mutation, use
  `commence_decision=approve` and `action_decision=proceed_to_plan`
- if the likely next lane is clear but mutation or planning should wait for
  maintainer confirmation, use `commence_decision=approve` and
  `action_decision=request_review`
- if the report is ambiguous, under-specified, or risky, use
  `commence_decision=hold` or `needs_human`

## Inputs

- `title` or `issue_title`: report title
- `body` or `issue_body`: report body
- `source`: source system such as `github_issue` or `support_request`
- `source_id`: source record id
- `source_url`: source URL
- `product_context` (optional): product-specific constraints or routing hints
- `operator_context` (optional): maintainer or support posture guidance
