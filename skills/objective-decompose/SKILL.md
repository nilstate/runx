---
name: objective-decompose
description: Decompose a build objective into governed runx execution steps.
---

# Objective Decompose

Break a build or automation objective into a bounded runx execution plan.

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

- `objective_summary`: one sentence capturing the deliverable.
- `orchestration_steps`: ordered array. Each step:
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
