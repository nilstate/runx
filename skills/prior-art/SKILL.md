---
name: prior-art
description: Research best-in-class skill and composite execution patterns for a proposed runx flow.
---

# Prior Art

Research existing tools, standards, protocols, and skill patterns relevant to
a proposed runx skill or execution flow. Produce verified findings that
constrain the design — not a survey, not a summary, but specific claims with
sources that the skill author needs to make decisions.

Priority order:

1. **Existing tools and CLIs.** If the skill wraps a tool, document the exact
   invocation surface: command name, required arguments, flags, environment
   variables, exit codes, stdout format. Read the tool's source or docs to
   verify — do not describe features from memory.

2. **Protocols and standards.** If the skill interacts with a protocol (MCP,
   A2A, OpenAPI), document the exact message shapes, mandatory fields, and
   version. Read the spec.

3. **Prior art in runx.** Check `skills/` and the registry. Could an existing
   skill be composed or extended instead of building from scratch?

   When `decomposition.required_skills` contains entries where `exists: true`,
   recommending reuse is a first-class output. Do not draft new primitives
   for work an existing skill already covers. Cite the existing skill by
   path in `recommended_flow` and `findings`, and scope any new design work
   to the composition glue around it rather than duplicating its internals.

4. **Governance patterns.** What scopes does this skill need? Where are the
   mutation boundaries? What approval or review checkpoints does the domain
   imply?

5. **Failure modes.** What goes wrong? Common error conditions, edge cases,
   partial-success scenarios, timeouts, missing context.

For each finding: state the claim, cite where you verified it, and note
whether it constrains the design or just confirms the current direction.
Mark confidence: `verified` (read the source), `likely` (docs or strong
inference), or `unverified` (could not confirm). If you could not verify
something, say so.

## Output

- `findings`: array of claims with `claim`, `source`, `relevance`, `confidence`.
- `recommended_flow`: suggested skill/execution flow based on findings.
- `sources`: references consulted (file paths, URLs, spec names, versions).
- `risks`: adoption, safety, or implementation risks with likelihood,
  impact, and mitigation.

## Inputs

- `objective` (required): the skill objective being researched.
- `decomposition` (optional): output from `work-plan`. When
  provided, focus on validating the proposed steps rather than surveying.
