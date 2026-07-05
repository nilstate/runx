---
name: schema-guard
description: Catch silent API and data contract breakage before a migration lands by diffing two JSON schemas, validating real sample payloads against both, and emitting a gated publish proposal only when the change passes the caller's compatibility policy.
runx:
  category: ops
---

# Schema Guard

Schema Guard reads a current schema, a proposed schema, real sample payloads,
and a compatibility policy. It reports every breaking change by field path,
validates each sample against both schemas, writes migration notes, and emits a
`publish_schema_proposal` only when the change is allowed. It never changes a
live schema.

The failure it prevents is the quiet one: a field removed, a type narrowed, an
optional made required, and the first sign is a consumer erroring in
production. Schema Guard turns that into a refusal at review time, with the
exact field path and both contracts in hand.

## What This Skill Does

1. **Validate inputs.** Refuse when either schema, the sample array, or the
   policy is missing or malformed. `breaking_allowed` must be an explicit
   boolean; the skill does not guess intent.
2. **Diff the schemas by field path.** Removed fields, changed types, narrowed
   enums, optional-to-required flips, new required fields, and closing
   `additionalProperties` are breaking. Added optional fields are additive.
   Every breaking change carries `field_path`, `old_contract`, `new_contract`,
   and the `policy_rule` that flagged it.
3. **Enforce policy-protected fields.** Fields listed in
   `compatibility_policy.required_fields` are breaking to remove or relax,
   even where the general rules would only note it.
4. **Validate real samples.** Each payload in `sample_payloads` is checked
   against both schemas. A sample that passes the current schema and fails the
   proposed one is direct evidence of breakage.
5. **Report coverage honestly.** Proposed-schema fields no sample exercises
   are named in `migration_notes`. An empty sample array is reported as empty
   coverage, never treated as passing coverage.
6. **Gate the proposal.** When the change is compatible (or breaking changes
   exist but `breaking_allowed` is true), the output includes a
   `publish_schema_proposal` with a version bump derived from
   `versioning_rule`. The proposal is consumed by a schema-publisher executor
   or a human approver; this skill performs no live schema write.

## Refusals And Stops

- Malformed or missing inputs exit with a usage refusal and no analysis.
- Breaking changes (or samples broken by the proposal) with
  `breaking_allowed: false` exit with a refusal: the full analysis is printed,
  no `publish_schema_proposal` is emitted, and the receipt records a failed
  run.
- Sample coverage is never invented. Gaps are named; absent samples are
  reported as absent.

## Inputs

- `current_schema` (required): the live contract as a JSON Schema object.
  Supported subset: `type`, `properties`, `required`, `items`, `enum`,
  `format`, `additionalProperties`.
- `proposed_schema` (required): the proposed replacement, same subset.
- `sample_payloads` (required): array of real payloads. Pass `[]` to state
  that no samples exist.
- `compatibility_policy` (required): `breaking_allowed` (boolean, required),
  `required_fields` (array of policy-protected field paths),
  `versioning_rule` (`semver`, `major-on-breaking`, or `minor-on-additive`).

## Output Schema

```yaml
compatibility:
  compatible: boolean            # no breaking changes and no samples broken
  allowed_under_policy: boolean  # compatible, or breaking_allowed is true
  breaking_changes:
    - field_path: string
      old_contract: string
      new_contract: string
      policy_rule: string
  additive_changes:
    - field_path: string
      new_contract: string
  samples_broken_by_proposal: [number]
  policy:
    breaking_allowed: boolean
    required_fields: [string]
    versioning_rule: string
validation_results:
  - payload_index: number
    valid_against_current: boolean
    valid_against_proposed: boolean
    current_errors: [string]
    proposed_errors: [string]
migration_notes: [string]
publish_schema_proposal:         # present only when allowed_under_policy
  kind: schema_publish_proposal
  gated: true
  proposed_schema: object
  version_bump: major | minor | patch
  breaking_changes: []
  migration_notes: [string]
```

## Quality Profile

- Purpose: stop silent contract breakage before a schema migration lands.
- Audience: API owners, data platform teams, and reviewers of schema PRs.
- Artifact contract: compatibility verdict, per-field breaking changes,
  per-sample validation results, migration notes, and a gated proposal.
- Evidence bar: every breaking change cites a field path and both contracts;
  every validation result cites the sample that produced it.
- Safety bar: read-only, deterministic, no network calls, no live schema
  writes; the proposal is a gated artifact for a downstream approver.
- Stop conditions: malformed input, breaking changes under a strict policy,
  or samples the proposal would break.
