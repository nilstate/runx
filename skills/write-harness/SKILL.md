---
name: write-harness
description: Draft replayable runx harness fixtures for a proposed skill package or composite execution plan.
---

# Write Harness

Draft replayable harness fixtures and acceptance checks that define what
correct behavior looks like for a skill, before or after implementation.

A runx harness fixture is a self-contained test case in YAML. It specifies
exact inputs, the target skill or chain, and assertions against the receipt
and step outputs. Fixtures are run by the harness runner in
`packages/core/src/harness/`.

## Fixture format

```yaml
name: descriptive-name
kind: skill                    # or "chain"
target: ../path/to/SKILL.md   # relative path to skill or chain YAML
inputs:
  input_name: value
expect:
  status: success              # or failure, needs_resolution, etc.
  receipt:
    kind: skill_execution      # or graph_execution
    status: success
    skill_name: expected-name
    source_type: cli-tool    # or agent, agent-step, chain, etc.
```

For chain fixtures, assert step completion:

```yaml
name: chain-completes
kind: graph
target: ../chains/my-chain.yaml
expect:
  status: success
  receipt:
    kind: graph_execution
    status: success
    graph_name: my-chain
  steps:
    - step-one
    - step-two
```

## Coverage strategy

Start from the skill contract (SKILL.md + execution profile). Design fixtures for:

- **Happy path**: one fixture with valid inputs exercising the primary
  flow. Assert the receipt kind, status, and the
  `skill_name`/`source_type` or `graph_name`/`owner` fields.
- **Missing required input**: one fixture omitting a required input.
  Expect `needs_resolution` status.
- **Tool not found**: if the skill wraps a CLI tool, one fixture with an
  invalid tool path. Expect failure with meaningful error.
- **Governance gates** (composite skills only): one fixture per approval
  or policy transition that matters.

Each fixture tests one thing. Do not combine happy-path and error checks.
Test the contract, not the internal wiring.

Fixtures must be reproducible — no network calls, no external state, no
wall clock dependencies. They should run in seconds.

For thread-driven skills, model the fixture inputs using portable runx nouns.
Prefer `thread_title`, `thread_body`, `thread_locator`, `thread`,
and `outbox_entry`. Adapter-specific identifiers should live inside the
locator or snapshot payload, not as top-level contract fields.

The resulting packet should read like a first-party runx proposal, not an
internal builder transcript. That means:

- treat "do not create a new skill" as a valid result when an existing skill,
  chain, or Sourcey/content path already solves the job
- name the real operator or maintainer pain the skill resolves
- explain catalog fit against adjacent current runx skills or chains
- describe the concrete user-visible artifact, not only the internal execution
  sequence
- convert unresolved ambiguity into explicit maintainer decisions
- keep issue comments, amendments, and approval records as provenance instead
  of copying them into the public proposal
- avoid placeholders such as `UNRESOLVED_*`, "supplied decomposition", or
  issue-number-specific contract wording in the skill contract itself

When the deliverable is a first-party runx skill proposal, prefer the implied
relative target `../<skill-name>` in harness fixtures instead of unresolved
placeholder targets. If artifact placement truly needs maintainer input, put
that in `maintainer_decisions` rather than leaking it into the fixture target.

## Quality Profile

- Purpose: turn the proposed contract into replayable proof and sharpen the
  proposal while doing it.
- Audience: implementers and reviewers who need to know what correct behavior
  means before code exists.
- Artifact contract: skill spec, execution plan when needed, pain points,
  catalog fit, maintainer decisions, harness fixtures, and acceptance checks.
- Evidence bar: fixtures must reflect the declared contract, prior-art
  constraints, and known failure modes. Do not invent unsupported behavior just
  to make a fuller matrix.
- Voice bar: maintainer-facing proposal language. Fixtures can be technical,
  but the surfaced proposal must not read like a trace, scaffold, or placeholder
  bundle.
- Strategic bar: every fixture should protect a user-visible promise, trust
  boundary, or failure mode that matters for the skill's purpose.
- Stop conditions: return `needs_resolution` when the contract is too vague to
  harness, and return `not_first_party` when the proposed skill should be reuse,
  Sourcey/content work, or a chain amendment instead.

## Output

- `skill_spec`: proposed SKILL.md content or update.
- `execution_plan`: proposed execution profile chain definition when the skill is
  composite. Step ids, skill references, scopes, context edges, policy.
- `pain_points`: one to three concrete operator or maintainer pain points the
  proposal addresses.
- `catalog_fit`: adjacent current runx skills or chains considered, plus why
  the proposal is a new first-party capability rather than a duplicate.
- `maintainer_decisions`: explicit review choices the maintainer still needs
  to make, if any.
- `harness_fixture`: array of fixture definitions in the format above.
  Minimum: one happy-path, one error-boundary. Return the full array even
  when only two fixtures are needed.
- `acceptance_checks`: concrete assertions the implementation must pass.

## Inputs

- `objective` (required): the skill objective to harness.
- `decomposition` (optional): output from `work-plan`.
- `research` (optional): output from `prior-art`.
- `review` (optional): output from `review-receipt` — write fixtures
  that specifically cover the diagnosed failure.

## When review is pass

If `review.verdict` is `pass` and `review.improvement_proposals` is
empty, the upstream diagnosis found nothing to fix. Do not invent
changes. Emit a minimal output: no `skill_spec` or `execution_plan`
update, and a single happy-path regression fixture that locks in
the current behaviour under the inputs that produced the pass
verdict. Treat `acceptance_checks` as confirmation statements, not
improvement assertions.
