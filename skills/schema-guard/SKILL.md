---
name: schema-guard
description: Check a proposed JSON Schema against the current one for breaking changes, validate sample payloads, and emit a gated publish proposal only when the change is compatible — never writing a live schema.
source:
  type: cli-tool
  command: node
  args:
    - run.mjs
runx:
  tags:
    - schema
    - compatibility
    - migration
links:
  source: https://github.com/epistemedeus/schema-guard
---

## What this skill does

This skill catches silent API and data-contract breakage before a migration
lands. It reads a `current_schema`, a `proposed_schema`, optional
`sample_payloads`, and a `compatibility_policy`. It reports every breaking change
by field path (with the old contract, the new contract, and the policy rule it
trips), validates each sample payload against the proposed schema, writes
migration notes, and emits a `publish_schema_proposal` **only** when the change
is compatible under the policy.

The skill is read-only and offline. It makes no network calls and never writes,
publishes, or mutates a live schema. Publishing a schema is the gated
`schema-publisher` executor's effect, performed only after approval.

## When to use this skill

Use this skill in a pull-request or migration pipeline to decide whether a schema
change is safe to ship. It is appropriate as a gate before a schema registry
update, an API version bump, or a database migration, and as the evidence step
before a human or the `schema-publisher` executor applies the change.

## When not to use this skill

Do not use it to apply or publish a schema — it only proposes. Do not treat a
compatible result as a guarantee of correctness beyond the declared policy and
the supplied samples: coverage is bounded by the schemas and payloads provided.
It checks a JSON-Schema subset (object properties, required, type, enum, nested
objects); it is not a full JSON-Schema validator for every keyword.

## Procedure

1. Read `current_schema` and `proposed_schema`; record a stable digest of each.
2. Diff the schemas field by field: a removed field, a narrowed type, a removed
   enum value, a newly required field, or a field made required is a breaking
   change; an added optional field or a relaxed requirement is additive.
3. Apply the `compatibility_policy`: `required_fields` must remain (violations
   always block), and `breaking_allowed` decides whether other breaking changes
   are permitted; `versioning_rule` is recorded.
4. Validate each `sample_payloads` entry against the proposed schema; a failing
   sample means the change breaks existing data.
5. Set `compatibility.compatible` true only when there are no policy violations,
   no failing samples, and either no breaking changes or `breaking_allowed`.
6. Emit `publish_schema_proposal` only when compatible; otherwise withhold it and
   write migration notes.
7. If a caller sets `apply`/`publish`/`write`, refuse and stop.

## Edge cases and stop conditions

Stop with an error when `current_schema` or `proposed_schema` is missing or is
not a JSON object. If a caller asks the skill to `apply`, `publish`, or `write`
the schema, it refuses and stops — that effect belongs to the gated
`schema-publisher` executor.

`block` is `true` whenever the change is not compatible (the migration should be
held); it is `false` when compatible. Breaking changes never silently pass:
each is reported with its field path and the policy rule it trips.

## Output schema

The primary output is `schema_guard_result`, with schema `schema.guard.result.v1`:

A compatible (additive) change — proposal emitted:

```json
{
  "schema": "schema.guard.result.v1",
  "skill": "schema-guard",
  "version": "0.1.0",
  "block": false,
  "compatibility": {
    "compatible": true,
    "breaking_changes": [],
    "breaking_allowed": false,
    "versioning_rule": "additive-only",
    "required_fields": ["id"],
    "policy_violations": []
  },
  "validation_results": [{ "payload_index": 0, "valid": true, "errors": [] }],
  "migration_notes": ["Additive-only change (1 field(s) added or relaxed); existing consumers remain valid."],
  "publish_schema_proposal": {
    "decision": "proposed",
    "performed_by": "schema-publisher",
    "requires_approval": true,
    "to_schema_digest": "sha256:...",
    "versioning_rule": "additive-only",
    "note": "Proposal only. schema-guard performs no live schema write..."
  },
  "summary": {
    "breaking_count": 0,
    "additive_count": 1,
    "policy_violation_count": 0,
    "samples_validated": 1,
    "samples_failed": 0,
    "proposal_status": "proposed"
  }
}
```

A breaking change withholds the proposal: `compatibility.compatible` is `false`,
`block` is `true`, `publish_schema_proposal` is `null`, `proposal_status` is
`withheld`, and each breaking change is listed with its `field_path`, `kind`,
`old_contract`, `new_contract`, and `policy_rule`.

When `output_dir` is provided, the runner also writes `evidence.json` and
`report.md` inside that directory.

## Worked example

An additive change adds an optional `email` field. The harness confirms it is
compatible and emits a proposal:

```bash
runx skill "$PWD" \
  --input-json current_schema='{"type":"object","properties":{"id":{"type":"integer"}},"required":["id"]}' \
  --input-json proposed_schema='{"type":"object","properties":{"id":{"type":"integer"},"email":{"type":"string"}},"required":["id"]}' \
  --input-json sample_payloads='[{"id":1}]' \
  --input-json compatibility_policy='{"breaking_allowed":false,"required_fields":["id"],"versioning_rule":"additive-only"}' \
  --json
```

Expected: `compatibility.compatible` is true, `publish_schema_proposal.performed_by`
is `schema-publisher`. Removing the required `id` field instead makes
`compatible` false, withholds the proposal, and lists the breaking change.

## Inputs

- `current_schema`: the current JSON Schema (required).
- `proposed_schema`: the proposed JSON Schema (required).
- `sample_payloads`: representative payloads validated against the proposed schema.
- `compatibility_policy`: `{ breaking_allowed, required_fields[], versioning_rule }`.
- `apply`: must be absent or false; if set, the skill refuses (it never writes a schema).
- `output_dir`: optional directory for `evidence.json` and `report.md`.

## Outputs

- `schema_guard_result`: the complete packet.
- `block`: boolean migration gate, true when the change is not compatible.
- `compatibility`: `{ compatible, breaking_changes[], ... }`.
- `validation_results`: per-sample validation against the proposed schema.
- `migration_notes`: human-readable guidance for each breaking change.
- `publish_schema_proposal`: gated proposal for the `schema-publisher` executor (only when compatible).
