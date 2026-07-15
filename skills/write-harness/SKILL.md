---
name: write-harness
description: Draft replayable runx harness fixtures for a proposed skill package or composite execution plan.
runx:
  category: authoring
---

# Write Harness

Draft replayable harness fixtures and acceptance checks that define what
correct behavior looks like for a skill, before or after implementation.

A runx harness fixture is a self-contained test case in YAML. It specifies
exact inputs, the target skill or graph, and assertions against the receipt
and step outputs. Put package fixtures directly under `fixtures/`; `runx harness
<skill-directory>` discovers them alongside any inline harness cases.

## Fixture format

```yaml
name: descriptive-name
kind: skill                    # or "graph"
target: ../path/to/SKILL.md   # relative path to skill or graph YAML
inputs:
  input_name: value
expect:
  status: sealed               # or failure, needs_agent, etc.
  receipt:
    schema: runx.receipt.v1
    status: sealed
    skill_name: expected-name
    source_type: cli-tool    # or agent, managed-agent, graph, etc.
```

For graph fixtures, assert step completion:

```yaml
name: graph-completes
kind: graph
target: ../graphs/my-graph.yaml
expect:
  status: sealed
  receipt:
    schema: runx.receipt.v1
    status: sealed
    graph_name: my-graph
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
  Expect `needs_agent` status.
- **Expected tool rejection**: if the skill wraps a CLI tool, one fixture that
  makes the tool execute and exit nonzero. Expect `failure` and assert the
  meaningful error in the sealed receipt.
- **Governance gates** (composite skills only): one fixture per approval
  or policy transition that matters.
- **Publication evidence**: for skills intended for registry or public use,
  include checks that prove the registry listing or public artifact is reachable,
  durable, and tied to the submitted source.
- **User-value boundary**: include at least one assertion or acceptance check
  that protects the real user-visible promise, not only internal step success.

Each fixture tests one thing. Do not combine happy-path and error checks.
Test the contract, not the internal wiring.

Fixtures must be reproducible — no network calls, no external state, no
wall clock dependencies. They should run in seconds.

`expect.status: failure` applies only after the governed tool actually runs and
returns a failed act. A fixture that cannot be loaded, a runner that cannot be
resolved, an invalid execution profile, or a tool process that cannot be spawned
is a broken harness. Those conditions must make `runx harness` exit nonzero;
never encode them as expected fixture outcomes.

For thread-driven skills, model the fixture inputs using portable runx nouns.
Prefer `thread_title`, `thread_body`, `thread_locator`, `thread`,
and `outbox_entry`. Adapter-specific identifiers should live inside the
locator or snapshot payload, not as top-level contract fields.

The resulting packet should read like a first-party runx proposal, not an
internal builder transcript. That means:

- treat "do not create a new skill" as a valid result when an existing skill,
  graph, or Sourcey/content path already solves the job
- name the real operator or maintainer pain the skill resolves
- explain catalog fit against adjacent current runx skills or graphs
- describe the concrete user-visible artifact, not only the internal execution
  sequence
- name who would use, trust, link, install, or maintain the artifact and why
- convert unresolved ambiguity into explicit maintainer decisions
- keep issue comments, amendments, and approval records as provenance instead
  of copying them into the public proposal
- avoid placeholders such as `UNRESOLVED_*`, "supplied decomposition", or
  issue-number-specific contract wording in the skill contract itself

When the deliverable is a first-party runx skill proposal, prefer the implied
relative target `../<skill-name>` in harness fixtures instead of unresolved
placeholder targets. If artifact placement truly needs maintainer input, put
that in `maintainer_decisions` rather than leaking it into the fixture target.

## Output

- `skill_spec`: proposed SKILL.md content or update.
- `execution_plan`: proposed execution profile graph definition when the skill is
  composite. Step ids, skill references, scopes, context edges, policy.
- `pain_points`: one to three concrete operator or maintainer pain points the
  proposal addresses.
- `catalog_fit`: adjacent current runx skills or graphs considered, plus why
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
