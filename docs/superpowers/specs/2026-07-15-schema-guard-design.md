# Schema Guard Design

## Objective

Deliver Frantic bounty #84 as the exact public package `schema-guard`. The
skill must read a current JSON Schema or OpenAPI schema from a real public
source during the governed run, compare a caller-supplied proposed schema,
validate representative payloads, refuse breaking changes, and record an
accepted compatible version through a consumed schema-registry effect.

## Acceptance Constraints

- Use `runx-cli 0.6.14` or newer for publish, install, harness, dogfood, and
  verification commands.
- Publish the exact package name `schema-guard` under the claimant's runx
  registry owner and open a clean PR against `runxhq/runx` containing only the
  package, fixtures, tests, and evidence.
- Dogfood must fetch the current schema from a real immutable public URL. A
  hand-pasted current schema is not accepted.
- Compatible changes must produce a consumed append effect and a readback that
  binds the stored version to the compatibility verdict digest.
- Breaking changes must identify the field path, old contract, new contract,
  and policy rule, and must not append a registry event.
- Receipts must use Ed25519 signing with `RUNX_RECEIPT_SIGN_KID`,
  `RUNX_RECEIPT_SIGN_ED25519_SEED_BASE64`, and
  `RUNX_RECEIPT_SIGN_ISSUER_TYPE=hosted`. Local-development skeleton receipts
  are not delivery evidence.
- The post-publish dogfood receipt and full `runx verify --json` output are the
  submitted receipt evidence.

## Chosen Architecture

`schema-guard` is a composed graph with three bounded stages:

1. **Source read** invokes the canonical `web-fetch` skill against a caller
   supplied immutable schema URL and allowlist. The fetched bytes and source
   URL are retained in the receipt trail.
2. **Compatibility evaluation** runs a deterministic Node.js module. It parses
   the current and proposed schemas, compares required properties and property
   contracts, validates supplied sample payloads, and emits typed
   `compatibility`, `validation_results`, `migration_notes`, and a deterministic
   verdict digest. It never infers coverage from absent samples.
3. **Registry effect** conditionally invokes the canonical `data-store`
   `append_event` runner only when the verdict is compatible. The event uses the
   `schema_registry_versions` resource and contains the version, source URL,
   proposed schema digest, compatibility digest, and validation summary. A
   readback proves the appended version is addressable and consumed.

The `data-store` transport is the bounty-permitted mock schema-registry
transport. It is used through runx's governed adapter rather than through an
untracked file write or an inert proposal object.

## Public Interface

The default graph runner accepts:

- `source_url: string` — immutable public URL for the current JSON
  Schema/OpenAPI document.
- `source_allowlist: json` — exact host allowlist for the source read.
- `proposed_schema: json` — proposed next schema.
- `sample_payloads: json` — representative payload array; it may be empty, but
  the result must state that sample coverage was not supplied.
- `compatibility_policy: json` —
  `{breaking_allowed, required_fields, versioning_rule}`.
- `registry_ref: string`, `registry_store_id: string`, `schema_id: string`,
  `expected_version: number`, and `idempotency_key: string` — explicit registry
  transport coordinates.

It emits:

- `compatibility` with `compatible`, `breaking_changes[]`, and
  `verdict_digest`.
- `validation_results[]` with one result per supplied payload.
- `migration_notes[]` grounded in detected changes.
- `publish_result` containing the append result and stored version when the
  compatible path executes; it is absent on refusal.

## Compatibility Rules

The first release supports deterministic object-schema rules that are useful
for JSON Schema and OpenAPI component schemas:

- Removing a previously required property is allowed only when policy permits
  breaking changes; otherwise it is breaking.
- Adding a new required property is breaking unless every supplied sample
  contains it and policy explicitly allows the versioning transition.
- Removing a property, changing its `type`, narrowing an `enum`, or changing a
  field from optional to required is breaking.
- Adding an optional property or widening an enum is compatible.
- Every breaking change reports JSON Pointer field path, old contract, new
  contract, and the exact policy rule.
- Unsupported or malformed schemas fail closed and execute no registry write.

## Harness and Test Strategy

Automated unit tests run the evaluator directly before any implementation is
accepted. They cover optional-property addition, property removal, required
field addition, type change, enum narrowing/widening, malformed source,
sample-payload validation, deterministic digests, and no invented coverage.

The runx harness contains at least:

1. `additive-compatible-recorded` — reads a real fixture through the source
   runner, accepts an additive optional field, appends the version, and exposes
   the stored `publish_result`.
2. `breaking-change-refused` — detects a required/type-breaking change, returns
   field-level evidence, and executes no append effect.
3. `unreachable-source-refused` — source read fails and no registry effect is
   emitted.

Dogfood uses an immutable raw GitHub URL for a maintained public schema and a
fresh local mock registry store. Verification checks the receipt signature,
issuer type, acts, source-read evidence, append effect, readback, output
digests, and absence of secrets.

## Evidence and Publication

All public artifact URLs are pinned to one PR head commit and one package
version. `evidence.json` contains the exact CLI version output, source read,
compatibility result, breaking changes, validation results, sealed publish
result, harness case statuses, package/install/publish commands, dogfood input,
dogfood command, receipt reference, and full verification verdict reference.
`verification.json` is captured verifier output, not a self-authored checklist.

The PR is created from current `upstream/main` and must not delete or modify
unrelated skills. The registry package, PR head, raw `X.yaml`, raw `SKILL.md`,
evidence, report, and dogfood receipt must all name the same source revision.

## Failure Handling

- Network, parse, unsupported-schema, and validation errors fail before any
  registry append.
- Breaking verdicts are represented as governed refusal evidence and never
  write a version event.
- Append conflicts surface the expected/current version mismatch and do not
  retry with a widened authority or altered expected version.
- Publish or hosted-harness failures stop delivery; no Frantic packet is sent
  until all required public URLs and hosted checks are green.

