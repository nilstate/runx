---
name: schema-guard
version: "0.1.0"
description: Compare a proposed schema against a current contract and emit a gated publish proposal only when compatibility is proven from policy and samples.
---
# schema-guard

`schema-guard` reviews a current schema, a proposed schema, bounded sample
payloads, and a compatibility policy. It reports whether the proposed schema is
safe to publish, identifies breaking changes by field path and policy rule, and
emits a `publish_schema_proposal` only when the change is compatible.

The skill does not write schemas, call registries, mutate repositories, or notify
customers. The proposal is gated for a human schema approver or the governed
`schema-publisher` executor from the runx-skills-v3 wave.

## Inputs

- `current_schema`: object with `name`, `version`, and `fields`.
- `proposed_schema`: object with `name`, `version`, and `fields`.
- `sample_payloads`: array of bounded sample objects to validate against both
  contracts.
- `compatibility_policy`: object with:
  - `breaking_allowed`: boolean.
  - `required_fields`: array of field names that must remain present and
    required.
  - `versioning_rule`: human-readable rule such as
    `semver_minor_for_additive` or `semver_major_for_breaking`.

Each field may be written as either `{type, required, enum}` or a simple type
string. Nested field names can be expressed with dot paths.

## Decision rules

1. Refuse missing or malformed current/proposed schemas.
2. Compare every current field with the proposed field at the same path.
3. Mark a breaking change when a required field is removed, a required field is
   made optional, a field type changes, an enum narrows, or a policy-required
   field is absent or optional.
4. Validate every supplied sample payload against the proposed schema and record
   missing required fields, type mismatches, and enum violations.
5. Treat missing sample coverage as unknown evidence, not proof.
6. If breaking changes exist and `breaking_allowed` is false, set
   `compatibility.compatible` to false and emit no `publish_schema_proposal`.
7. If there are no blocking changes, emit a gated proposal containing the schema
   name, version transition, field changes, sample count, validation summary,
   and approval gate.
8. Never invent sample coverage, live registry state, or unpublished schema
   effects.

## Output schema

The runner emits `runx.schema_guard.v1`:

```json
{
  "status": "compatible",
  "compatibility": {
    "compatible": true,
    "status": "compatible",
    "summary": "Additive schema change is compatible with the supplied policy.",
    "breaking_changes": [],
    "unknowns": []
  },
  "validation_results": [
    {
      "sample_index": 0,
      "valid_current": true,
      "valid_proposed": true,
      "missing_required": [],
      "type_mismatches": [],
      "enum_violations": []
    }
  ],
  "migration_notes": [
    {
      "kind": "additive_field",
      "field_path": "memo",
      "note": "Optional field added; existing samples remain valid."
    }
  ],
  "publish_schema_proposal": {
    "target": "schema-publisher",
    "approval_gate": "requires_human_or_schema_publisher_approval",
    "schema_name": "invoice_event",
    "from_version": "1.0.0",
    "to_version": "1.1.0",
    "proposal_status": "ready_for_review"
  },
  "evidence": {
    "side_effects": "none",
    "sample_count": 2,
    "compatibility_status": "compatible",
    "breaking_changes_count": 0,
    "proposal_status": "ready_for_review"
  }
}
```

When a breaking change is refused, `publish_schema_proposal` is `null`,
`compatibility.compatible` is `false`, and each breaking change includes:

- `field_path`
- `old_contract`
- `new_contract`
- `policy_rule`

## Worked example

```bash
runx skill ./skills/schema-guard \
  --runner guard \
  --input-json current_schema='{"name":"invoice_event","version":"1.0.0","fields":{"id":{"type":"string","required":true}}}' \
  --input-json proposed_schema='{"name":"invoice_event","version":"1.1.0","fields":{"id":{"type":"string","required":true},"memo":{"type":"string","required":false}}}' \
  --input-json sample_payloads='[{"id":"inv_1","memo":"ok"}]' \
  --input-json compatibility_policy='{"breaking_allowed":false,"required_fields":["id"],"versioning_rule":"semver_minor_for_additive"}' \
  --json
```

Expected result: `compatibility.compatible = true`, zero breaking changes, sample
validation recorded, and a gated `publish_schema_proposal` for review.

## Validation

Run from the repository root:

```bash
runx harness ./skills/schema-guard
```

Expected harness cases:

- `additive-compatible-proposal`: sealed, compatible, emits a gated proposal.
- `breaking-change-refused-no-proposal`: sealed, detects breaking changes and
  emits no proposal.
- `missing-schema-failure`: fails when the required schema input is absent.

## Safety boundary

`schema-guard` is non-mutating. It does not publish schemas, write files outside
its run, change registries, call external services, send notifications, or claim
that sample coverage exists when it was not supplied. It only emits a reviewable
compatibility packet.
