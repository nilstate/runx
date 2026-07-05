---
name: schema-guard
description: Check API or data schema changes against sample payloads and a compatibility policy before a schema proposal is published.
source:
  type: cli-tool
  command: node
  args:
    - run.mjs
  timeout_seconds: 15
  sandbox:
    profile: readonly
    cwd_policy: skill-directory
inputs:
  current_schema:
    type: json
    required: true
    description: Current JSON-schema-like object contract.
  proposed_schema:
    type: json
    required: true
    description: Proposed JSON-schema-like object contract.
  sample_payloads:
    type: json
    required: true
    description: Array of real sample payloads to validate against the proposed schema.
  compatibility_policy:
    type: json
    required: true
    description: Policy object with breaking_allowed, required_fields, and versioning_rule.
runx:
  category: ops
  input_resolution:
    required:
      - current_schema
      - proposed_schema
      - sample_payloads
      - compatibility_policy
  artifacts:
    named_emits:
      compatibility: runx.schema_guard.compatibility.v1
      validation_results: runx.schema_guard.validation_results.v1
      migration_notes: runx.schema_guard.migration_notes.v1
      publish_schema_proposal: runx.schema_guard.publish_schema_proposal.v1
---

# Schema Guard

`schema-guard` checks whether a proposed API or data contract can move forward
without silently breaking callers. It reads the current schema, proposed schema,
real sample payloads, and a compatibility policy. It reports breaking changes,
validates samples against the proposed contract, and emits a
`publish_schema_proposal` only when the change is allowed by policy.

The skill never writes a live schema. Its proposal is a gated handoff for a
human schema approver or a separate schema-publisher executor.

## Use This Skill When

- A migration, API version, or event contract is about to land.
- A maintainer needs a deterministic compatibility report before publishing.
- A workflow needs a receipt showing why a schema proposal was allowed or held.

## Do Not Use This Skill For

- Live schema writes or registry publication.
- Inventing sample coverage. If a sample does not cover a path, the report says
  that directly.
- Broad API design review. This skill only checks the supplied contract delta,
  policy, and payload samples.

## Inputs

- `current_schema`: JSON-schema-like object contract currently in force.
- `proposed_schema`: JSON-schema-like object contract being reviewed.
- `sample_payloads`: array of real sample payload objects.
- `compatibility_policy`: object with:
  - `breaking_allowed`: boolean.
  - `required_fields`: array of field paths that must remain present.
  - `versioning_rule`: string such as `minor_allows_additive_only`.

## Outputs

- `compatibility`: object with `status`, `breaking_changes`, and policy result.
- `validation_results`: array of sample validation results against the proposed
  schema.
- `migration_notes`: array of notes about additive, removed, or changed fields
  and sample coverage.
- `publish_schema_proposal`: emitted only when the proposal is compatible under
  the supplied policy. It is a proposal, not a live schema write.

## Procedure

1. Normalize both schemas into field paths.
2. Compare field paths, required status, type, enum, and object shape.
3. Mark removals, type changes, enum narrowing, newly required fields, and
   required policy-field removals as breaking changes.
4. Validate every supplied sample payload against the proposed schema.
5. Record sample coverage by field path without inventing missing coverage.
6. Emit `publish_schema_proposal` only when policy permits the change and all
   samples validate.

## Refusal Conditions

- `breaking_allowed` is false and at least one breaking change is found.
- Any sample payload fails the proposed schema.
- A field named in `compatibility_policy.required_fields` is absent from the
  proposed schema.
- Inputs are malformed or `sample_payloads` is not an array.
