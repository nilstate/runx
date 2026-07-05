---
name: schema-guard
description: Validate bounded schema changes and produce a review-only schema publication proposal for compatible changes.
source:
  type: cli-tool
---

# schema-guard

`schema-guard` checks whether a proposed object schema is compatible with an
existing schema, validates supplied sample payloads against the proposed
contract, and emits a review-only publication proposal only when the change is
compatible.

The skill is intentionally side-effect free. It does not publish, mutate, or
write live schemas. A caller must take the emitted `publish_schema_proposal`
through a separate review and publish path.

## Inputs

- `current_schema` (json, required): the existing schema contract. Supported
  forms are `{ fields: { name: { type, required } } }` and a minimal JSON
  Schema object with `properties` and `required`.
- `proposed_schema` (json, required): the candidate schema contract in the same
  shape.
- `sample_payloads` (json, required): bounded example payloads. Entries may be
  direct payload objects or `{ id, payload }` records.
- `compatibility_policy` (json, required): policy settings:
  - `breaking_allowed`: boolean, defaults to `false`.
  - `required_fields`: fields that must remain present in the proposed schema.
  - `versioning_rule`: a human-readable version rule recorded in evidence.

## Outputs

- `compatibility`: compatibility decision, detected additive changes, breaking
  changes, and policy rule references.
- `validation_results`: per-sample validation results against the proposed
  schema.
- `migration_notes`: operator-readable notes for review.
- `publish_schema_proposal`: present only when the change is compatible and the
  supplied sample payloads validate.

## Guardrails

- Do not invent sample coverage. If no sample payloads are supplied, return a
  refused compatibility decision and omit `publish_schema_proposal`.
- Treat field removals, type changes, and optional-to-required changes as
  breaking unless `compatibility_policy.breaking_allowed` is true.
- Treat policy-required fields missing from the proposed schema as breaking.
- Never write live schemas or call remote publish APIs.
