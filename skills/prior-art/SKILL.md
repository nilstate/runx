---
name: prior-art
description: Compare existing approaches, catalog surfaces, and domain patterns before runx designs, drafts, or acts.
runx:
  category: authoring
---

# Prior Art

Compare existing tools, standards, protocols, catalog surfaces, content
patterns, and domain precedents relevant to one bounded runx objective.
Produce verified findings that constrain the next artifact — not a survey, not
a summary, but specific claims with sources that a maintainer, author, or
operator needs to make a better decision.

`prior-art` is not only for skill design. It should support Sourcey docs
outreach, skill research, ecosystem briefs, content drafts, issue responses,
release narratives, and any graph that needs to know what already exists before
it produces an artifact.


Priority order:

1. **Existing tools and CLIs.** If the skill wraps a tool, document the exact
   invocation surface: command name, required arguments, flags, environment
   variables, exit codes, stdout format. Read the tool's source or docs to
   verify — do not describe features from memory.

2. **Protocols and standards.** If the skill interacts with a protocol (MCP,
   A2A, OpenAPI), document the exact message shapes, mandatory fields, and
   version. Read the spec.

3. **Prior art in runx.** Check `skills/` and the registry. Could an existing
   skill, graph, Sourcey docs path, content path, or issue workflow be reused
   or amended instead of creating a new first-party surface?

   When `decomposition.required_skills` contains entries where `exists: true`,
   recommending reuse is a first-class output. Do not draft new primitives
   for work an existing skill already covers. Cite the existing skill by
   path in `recommended_flow` and `findings`, and scope any new design work
   to the composition glue around it rather than duplicating its internals.

   Be concrete about catalog fit. Name the adjacent current skill, graph, or
   content surface, explain the boundary it already owns, and say exactly what
   remains unsolved. "Not quite right" is not enough. The downstream artifact
   should either clearly reuse the current catalog or clearly explain the gap.

4. **Audience and artifact precedents.** What would high-quality output look
   like for this audience? For docs, inspect native project vocabulary and
   information architecture. For outreach, inspect community norms. For briefs,
   inspect what would change the operator's decision. For skills, inspect
   adjacent skill contracts and examples.

5. **Governance patterns.** What scopes does the graph need? Where are the
   mutation, publication, or handoff boundaries? What approval or review
   checkpoints does the domain imply?

6. **Failure modes.** What goes wrong? Common error conditions, edge cases,
   partial-success scenarios, timeouts, missing context.

For each finding: state the claim, cite where you verified it, and note
whether it constrains the design or just confirms the current direction.
Mark confidence: `verified` (read the source), `likely` (docs or strong
inference), or `unverified` (could not confirm). If you could not verify
something, say so.

## Output

- `findings`: array of claims with `claim`, `source`, `relevance`, `confidence`.
- `recommended_flow`: suggested skill/execution flow based on findings.
- `catalog_fit`: concise explanation of which current runx skills or graphs
  were considered, where they stop, and why the next artifact is new work,
  reuse, amendment, or a clean stop rather than duplication.
- `quality_bar`: audience, artifact, evidence, voice, and stop conditions that
  should constrain the downstream skill.
- `sources`: references consulted (file paths, URLs, spec names, versions).
- `risks`: adoption, safety, or implementation risks with likelihood,
  impact, and mitigation.

## Inputs

- `objective` (required): the bounded objective being researched.
- `decomposition` (optional): output from `work-plan`. When
  provided, focus on validating the proposed steps rather than surveying.
- `graph_purpose` (optional): why the caller is researching this objective,
  such as `skill_proposal`, `sourcey_docs`, `content_draft`,
  `ecosystem_brief`, `issue_response`, or `release`.
- `audience` (optional): who will read or act on the downstream artifact.
- `artifact_contract` (optional): expected downstream output shape.
