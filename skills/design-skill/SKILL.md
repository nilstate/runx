---
name: design-skill
description: Turn a product or automation objective into a bounded runx skill package proposal.
---

# Design Skill

Convert an automation or product objective into a practical, testable runx
skill package.

This is a composite chain that composes three reusable builder capabilities:
`work-plan` → `prior-art` → `write-harness`. It takes a
high-level goal and produces everything needed to implement and test a
new skill.

The quality bar is not just structural completeness. The result should read
like a crisp first-party runx skill proposal that a maintainer could plausibly
review for the catalog:

- treat "no new skill" as a valid high-quality outcome when the job belongs in
  Sourcey, `draft-content`, an existing skill, or an existing chain
- name the concrete operator, maintainer, or workflow pain being solved
- explain why the current runx catalog does not already cover the job through
  an existing skill or chain
- show the bounded artifact a real user would receive, not just the automation
  steps that would run
- translate ambiguity into explicit maintainer decisions, not loose planning
  residue
- keep evidence, issue discussion, and approval mechanics as provenance; do not
  turn them into the reader-facing proposal body
- avoid builder-internal language such as "supplied decomposition",
  `UNRESOLVED_*` placeholders, issue-number-specific contract fields, or
  repo-local path hedging that would look wrong in a first-party proposal

When the proposed skill is thread-driven, the generated contract should model
portable runx nouns, not provider nouns. Prefer `thread_title`,
`thread_body`, `thread_locator`, `thread`, and `outbox_entry` over
adapter-shaped fields such as issue ids, thread URLs, or provider-specific
review handles.

## What this skill does

1. **Decompose the objective** (via `work-plan`). Breaks the
   objective into governed runx execution steps. Identifies the
   deliverable, governance boundaries, required skills, data dependencies,
   scope requirements, and open questions.

2. **Research the domain** (via `prior-art`). Given the decomposition,
   investigates existing tools, protocols, prior art in the runx ecosystem,
   and failure modes. Produces verified findings with source references
   that constrain the skill design.

3. **Author the skill and fixtures** (via `write-harness`). Using the
   decomposition and research, drafts the skill contract (SKILL.md),
   composite execution plan (execution profile chain definition if needed), replayable
   harness fixtures, and acceptance checks.

## What this skill produces

- **Skill contract**: a complete SKILL.md with frontmatter, instructions,
  inputs, outputs, and boundary rules. Ready to implement.
- **Execution plan**: a execution profile chain definition when the skill needs
  multiple governed steps. Includes step ids, skill references, scopes,
  context edges, and policy transitions.
- **Pain-point summary**: one to three concrete problems this skill resolves
  for a real operator or maintainer, grounded in the request rather than
  generic automation language.
- **Catalog fit**: adjacent runx skills or chains considered, why reuse alone
  is insufficient, and why the proposed skill earns its place without
  duplicating the current catalog.
- **Maintainer decisions**: explicit review questions or accept/reject/change
  choices when the design still needs human direction.
- **Harness fixtures**: replayable test cases covering the happy path
  and error boundaries. Ready to run against the implementation.
- **Acceptance checks**: concrete assertions the implementation must
  pass before the skill can ship.

## When to use this skill

- You have a clear automation objective and want a complete skill design
  before writing code.
- You want to validate that an objective is feasible and well-scoped
  before committing to implementation.
- You want to produce test fixtures before the implementation exists
  (test-first design).

## When not to use this skill

- For improving an existing skill — use `improve-skill` instead.
- For just the decomposition step — use `work-plan` directly.
- For just research — use `prior-art` directly.
- When the skill is trivial enough that writing SKILL.md directly is
  faster than running a three-step chain.

## Inputs

- `objective` (required): the capability or automation objective to
  design. Be specific about the deliverable: "generate docs for a
  project using Sourcey" not "make docs better."
- `project_context` (optional): repo, product, or operator context
  that constrains the design. Include language, framework, existing
  tooling, governance requirements, and any constraints on scope.
- `thread` (optional): portable bounded thread when the
  objective comes from an existing issue, chat, ticket, or other adapter
  surface.
