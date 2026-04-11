---
name: harness-author
description: Draft replayable runx harness fixtures for a proposed skill package or composite execution plan.
---

# Harness Author

Draft replayable harness fixtures and acceptance checks that define what
correct behavior looks like for a skill, before or after implementation.

A runx harness fixture is a self-contained test case in YAML. It specifies
exact inputs, the target skill or chain, and assertions against the receipt
and step outputs. Fixtures are run by the harness runner in
`packages/harness/`.

## Fixture format

```yaml
name: descriptive-name
kind: skill                    # or "chain"
target: ../path/to/SKILL.md   # relative path to skill or chain YAML
inputs:
  input_name: value
expect:
  status: success              # or failure, missing_context, etc.
  receipt:
    kind: skill_execution      # or chain_execution
    status: success
    subject:
      skill_name: expected-name
      source_type: cli-tool    # or agent, agent-step, chain, etc.
```

For chain fixtures, assert step completion:

```yaml
name: chain-completes
kind: chain
target: ../chains/my-chain.yaml
expect:
  status: success
  receipt:
    kind: chain_execution
    status: success
    subject:
      chain_name: my-chain
  steps:
    - step-one
    - step-two
```

## Coverage strategy

Start from the skill contract (SKILL.md + x.yaml). Design fixtures for:

- **Happy path**: one fixture with valid inputs exercising the primary
  flow. Assert the receipt kind, status, and subject fields.
- **Missing required input**: one fixture omitting a required input.
  Expect `missing_context` status.
- **Tool not found**: if the skill wraps a CLI tool, one fixture with an
  invalid tool path. Expect failure with meaningful error.
- **Governance gates** (composite skills only): one fixture per approval
  or policy transition that matters.

Each fixture tests one thing. Do not combine happy-path and error checks.
Test the contract, not the internal wiring.

Fixtures must be reproducible — no network calls, no external state, no
wall clock dependencies. They should run in seconds.

## Output

- `skill_spec`: proposed SKILL.md content or update.
- `execution_plan`: proposed x.yaml chain definition when the skill is
  composite. Step ids, skill references, scopes, context edges, policy.
- `harness_fixture`: array of fixture definitions in the format above.
  Minimum: one happy-path, one error-boundary.
- `acceptance_checks`: concrete assertions the implementation must pass.

## Inputs

- `objective` (required): the skill objective to harness.
- `decomposition` (optional): output from `objective-decompose`.
- `research` (optional): output from `skill-research`.
- `review` (optional): output from `receipt-review` — write fixtures
  that specifically cover the diagnosed failure.
