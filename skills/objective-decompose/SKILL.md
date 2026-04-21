---
name: objective-decompose
description: Decompose a build objective into governed runx execution steps.
---

# Objective Decompose

Break a build or automation objective into a bounded runx execution plan.

For cross-repo or cross-surface work, the output must be a phased
`workspace_change_plan`, not just a loose list of steps. The shared plan is the
thing that keeps repo-local workers aligned when one issue fans out into
multiple mutation surfaces.

When the objective originates from an existing subject thread, treat that thread
as provider-backed subject memory. GitHub issues, chat threads, support
tickets, and local agent sessions are adapter examples, not core nouns. The
plan should preserve the generic `subject_locator` and any supplied
`subject_memory`.

The central insight: split at governance boundaries, not cognitive boundaries.
A skill keeps its full context window. If two actions need the same context
but different scopes, they are two invocations of the same skill with
different scopes — not two separate skills. The chain defines where authority
changes, where mutation happens, and where a gate needs to approve. That is
where steps break.

Work backward from the deliverable. Name the concrete artifact the objective
produces (spec, patch, PR, docs site, report). Then identify where authority
narrows: read-only analysis, write-access mutation, approval gates, review
boundaries. Each narrowing is a step boundary. Each step gets only the scopes
it needs — no step inherits from a prior step, each derives from the chain
grant independently.

Determine data dependencies between steps. A step that consumes output from
a prior step must come after it. Steps with no data dependency are candidates
for fanout. Do not parallelize steps that share mutation targets.

If the objective is ambiguous or required context is missing, surface open
questions explicitly rather than guessing. Open questions should name what
is missing, why it matters, and who can answer it.

Prefer fewer steps with clear scope boundaries. Three well-scoped steps
beat seven single-purpose fragments. Every step should have a clear entry
condition, action, and exit artifact.

## Output

- `change_set`: the parent change artifact inherited from intake or constructed
  for the objective when intake did not already produce one. It should preserve
  the shared objective, target surfaces, invariants, and success criteria.
- `objective_summary`: one sentence capturing the deliverable.
- `workspace_change_plan`: phased plan for the whole change set. It must
  contain:
  - `plan_id`
  - `change_set_id`
  - `objective_summary`
  - `shared_invariants`
  - `success_criteria`
  - `phases`: ordered array. Each phase:
    - `id`
    - `name`
    - `depends_on`: prior phase ids
    - `parallelizable`: boolean
    - `repo_change_requests`: ordered array. Each request:
      - `repo`
      - `task_id`
      - `objective`
      - `depends_on`: sibling repo change request ids this request waits on
      - `shared_context_refs`: references into the parent change set or prior
        phase outputs
      - `validation_commands`
      - `mutating`
  - `integration_checks`: cross-repo checks that must pass before the overall
    change set is considered done
  - `open_questions`
- `orchestration_steps`: compatibility view of the plan as an ordered array.
  Each step:
  - `id`: kebab-case identifier
  - `skill`: skill name or path
  - `scopes`: scope strings this step requires
  - `mutating`: boolean
  - `inputs`: static input map
  - `context_from`: `step_id.output_field` data dependency references
  - `description`: what this step does and produces
- `required_skills`: skill names needed. Flag which exist vs need creation.
- `open_questions`: missing context that must be answered before mutation.

## Inputs

- `objective` (required): the build or skill objective to decompose.
- `project_context` (optional): repo, product, or user context that
  constrains the decomposition.
- `change_set` (optional): parent change artifact from `support-triage` or a
  workspace supervisor. Prefer this when present.
- `subject_locator` (optional): canonical locator for the bounded subject the
  plan is serving.
- `subject_memory` (optional): portable subject memory when the objective is
  grounded in an existing issue, chat, ticket, or other adapter surface.
