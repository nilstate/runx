---
name: objective-to-skill
description: Turn a product or automation objective into a bounded runx skill package proposal.
---

# Objective to Skill

Convert an automation or product objective into a practical, testable runx
skill package.

This is a composite skill that chains three reusable builder capabilities:
`objective-decompose` → `skill-recon` → `harness-author`. It takes a
high-level goal and produces everything needed to implement and test a
new skill.

When the proposed skill is subject-driven, the generated contract should model
portable runx nouns, not provider nouns. Prefer `subject_title`,
`subject_body`, `subject_locator`, `subject_memory`, and `publication_target` over
adapter-shaped fields such as issue ids, thread URLs, or provider-specific
review handles.

## What this skill does

1. **Decompose the objective** (via `objective-decompose`). Breaks the
   objective into governed runx execution steps. Identifies the
   deliverable, governance boundaries, required skills, data dependencies,
   scope requirements, and open questions.

2. **Research the domain** (via `skill-recon`). Given the decomposition,
   investigates existing tools, protocols, prior art in the runx ecosystem,
   and failure modes. Produces verified findings with source references
   that constrain the skill design.

3. **Author the skill and fixtures** (via `harness-author`). Using the
   decomposition and research, drafts the skill contract (SKILL.md),
   composite execution plan (execution profile chain definition if needed), replayable
   harness fixtures, and acceptance checks.

## What this skill produces

- **Skill contract**: a complete SKILL.md with frontmatter, instructions,
  inputs, outputs, and boundary rules. Ready to implement.
- **Execution plan**: a execution profile chain definition when the skill needs
  multiple governed steps. Includes step ids, skill references, scopes,
  context edges, and policy transitions.
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
- For just the decomposition step — use `objective-decompose` directly.
- For just research — use `skill-recon` directly.
- When the skill is trivial enough that writing SKILL.md directly is
  faster than running a three-step chain.

## Inputs

- `objective` (required): the capability or automation objective to
  design. Be specific about the deliverable: "generate docs for a
  project using Sourcey" not "make docs better."
- `project_context` (optional): repo, product, or operator context
  that constrains the design. Include language, framework, existing
  tooling, governance requirements, and any constraints on scope.
- `subject_memory` (optional): portable bounded subject memory when the
  objective comes from an existing issue, chat, ticket, or other adapter
  surface.
