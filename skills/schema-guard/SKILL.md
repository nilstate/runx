---
name: schema-guard
description: Read a current schema from an allowlisted source, judge a deterministic compatibility subset, and record only compatible versions through a governed append plus readback.
runx:
  category: data
---

# Schema Guard

`schema-guard` is a governed **read / judge / record** graph for schema evolution.
It reads the current schema from a caller-selected HTTP(S) source, evaluates a
proposed object schema and representative payloads deterministically, then
records the accepted version through an append-only registry effect and reads
the same aggregate back. The default runner is the graph runner named
`schema-guard`; the package version is exactly `0.1.0`.

## Read / judge / record

1. **Read — `fetch-current`:** the vendored canonical `web-fetch` skill fetches
   `source_url` with `extract: text`. The source host and every redirect host
   must match `source_allowlist`. The resulting final URL, HTTP status, body
   digest, extracted text, redirect chain, byte count, and truncation flag are
   sealed in the execution trace.
2. **Judge — `evaluate`:** `run.mjs` requires a complete HTTP 2xx,
   non-truncated fetch result with a SHA-256 content digest, parses the fetched
   document, validates both schemas against the supported subset, compares the
   contracts, validates every supplied sample, and emits deterministic verdict
   evidence. It also constructs the exact registry event for a compatible
   verdict. That event includes the source digest, compatibility verdict
   digest, proposed-schema digest, validation summary, and its own event digest.
3. **Record — `append-version` then `readback`:** a policy guard permits the
   vendored canonical `data-store` append only when
   `compatibility.compatible` is `true`. The append consumes
   `evaluate.registry_event`; the readback uses the identical
   `registry_ref`, `registry_store_id`, `schema_registry_versions` resource,
   and `schema_id` aggregate. Together the committed append result and stored
   readback are the evidence used for publication, not an inert proposal.
4. **Project — `project-result`:** a terminal CLI-tool step accepts only the
   declared evaluator, append, and readback evidence. It verifies the event,
   verdict, source, stored-event, and readback digest/version bindings, removes
   provider evidence, and emits the four public contract fields.

## Supported schema subset

The first release accepts object-shaped JSON Schema documents and object-shaped
OpenAPI component schemas that use only this deterministic subset:

- root: `$id`, `type`, `properties`, and `required`;
- nested schemas: `type`, `properties`, `required`, `items`, `enum`, and
  `format`;
- types: `null`, `boolean`, `string`, `number`, `integer`, `array`, `object`;
- string formats: `date`, `date-time`, `email`, `hostname`, `ipv4`, `time`,
  `uri`, and `uuid`;
- policy versioning rule: `semver_minor_for_additive`.

Every schema node must declare a supported `type`. Required names must identify
declared properties and may not repeat. Enum values must match their declared
type. `properties` is valid only on objects and `items` only on arrays.

Compatibility rules are recursive. Adding an optional property and widening an
existing enum are compatible. Removing a property, adding a required property,
changing optional to required, changing a property type, narrowing an enum,
adding a stricter format, or introducing array item restrictions is breaking.
Each breaking item reports a JSON Pointer path, `old_contract`, `new_contract`,
and `policy_rule`. Fields listed by `compatibility_policy.required_fields` must
remain required. Invalid representative payloads make the verdict incompatible.

This release does not interpret `$ref`, composition (`allOf`, `anyOf`,
`oneOf`), conditionals, numeric/string bounds, `pattern`,
`additionalProperties`, discriminator rules, or arbitrary OpenAPI documents.
Such input is unsupported rather than approximated.

## Fail-closed behavior and refusal evidence

- Missing inputs, malformed JSON, unsupported keywords or types, invalid
  policy, non-2xx fetches, provider errors, invalid digests, and truncated
  source reads fail before a registry append.
- A breaking or sample-invalid verdict completes `fetch-current` and
  `evaluate`, then the append guard seals a `policy_denied` graph receipt.
  Neither `append-version` nor `readback` executes.
- An unreachable source fails during evaluation of the incomplete fetch
  evidence. No append, readback, or result projection executes.
- Version conflicts and idempotency conflicts surface from `data-store`; the
  graph does not retry with altered authority, version, event, or retry key.
- Source and registry coordinates are explicit inputs. The graph cannot widen
  the source allowlist, invent a registry binding, run raw SQL, expose provider
  credentials, or bypass the compatibility guard.

## Inputs

| Input | Type | Required | Meaning |
| --- | --- | --- | --- |
| `source_url` | string | yes | Immutable HTTP(S) URL of the current schema. |
| `source_allowlist` | json | yes | Exact or leading-wildcard hosts permitted for the read and redirects. |
| `proposed_schema` | json | yes | Proposed object schema in the supported subset. |
| `sample_payloads` | json | yes | Array of payloads checked against the proposal; `[]` is allowed and reported as no supplied coverage. |
| `compatibility_policy` | json | yes | `{breaking_allowed, required_fields, versioning_rule}`. |
| `registry_ref` | string | yes | Logical data-source reference selected by the operator. |
| `registry_store_id` | string | yes | Deterministic local fixture store id; use a unique value per harness case. |
| `schema_id` | string | yes | Aggregate id in `schema_registry_versions`. |
| `expected_version` | number | yes | Non-negative integer required by optimistic concurrency. |
| `idempotency_key` | string | yes | Non-empty stable key for this exact append event. |

## Outputs and graph JSON paths

- `compatibility: object` — `compatible`, ordered `breaking_changes`, sample
  coverage state, and deterministic `verdict_digest`.
- `validation_results: array` — one entry per sample with `index`, `valid`, and
  structured validation errors.
- `migration_notes: array` — deterministic notes grounded in detected additive
  or breaking paths.
- `publish_result: object` — present on the compatible sealed path as the graph
  evidence joining sanitized append and readback results. Its direct
  `event_digest`, `stored_event_digest`, `verdict_digest`, and `source_digest`
  fields bind the evaluated event and source to the committed event and stored
  projection/version. Refused and failed paths have no publish result.

The root `runx skill ... --json` response remains the runtime graph envelope;
it does **not** invent these names as root JSON fields. Read the typed terminal
contract at `payload.step_outputs.project-result.<output-name>.data`, for
example `payload.step_outputs.project-result.publish_result.data`. When this
graph is used as a nested graph step, the current runtime adopts the terminal
step contract, so callers consume `<outer-step>.<output-name>.data` without a
nested `step_outputs` hop. The runner output declaration and `project-result`
output declaration are identical: exactly `compatibility`,
`validation_results`, `migration_notes`, and `publish_result`.

The internal `registry_event` is consumed by `append-version`; it is not an
alternative inert output. Its `compatibility_digest` equals
`compatibility.verdict_digest`, while `source.content_digest` binds the event to
the bytes fetched during this run.

## Install and run

The package is self-contained. `graph/web-fetch` and `graph/data-store`
contain the pinned canonical dependency files, and the vendored data-store
includes its local, SQLite, and Redis tool adapters. It does not resolve
`../web-fetch`, `../data-store`, or any preinstalled registry dependency.

Install from a registry reference and inspect the exact graph contract:

```bash
runx add <owner>/schema-guard@0.1.0 --json
runx skill inspect <owner>/schema-guard@0.1.0 schema-guard --json
```

Run locally with JSON values supplied through `--input-json`:

```bash
runx skill ./skills/schema-guard schema-guard \
  -i source_url=https://raw.githubusercontent.com/qq2401672073-hub/runx/224532774bdf6067757cac84d15656029e4327db/skills/schema-guard/fixtures/current-invoice.schema.json \
  --input-json source_allowlist='["raw.githubusercontent.com"]' \
  --input-json proposed_schema='{"$id":"https://schemas.example.invalid/invoice/v1","type":"object","required":["id","status"],"properties":{"id":{"type":"string"},"status":{"type":"string","enum":["draft","paid"]},"memo":{"type":"string"}}}' \
  --input-json sample_payloads='[{"id":"inv-1","status":"paid"}]' \
  --input-json compatibility_policy='{"breaking_allowed":false,"required_fields":["id","status"],"versioning_rule":"semver_minor_for_additive"}' \
  -i registry_ref=local://schema-guard/example \
  -i registry_store_id=schema-guard-example-v1 \
  -i schema_id=invoice \
  --input-json expected_version=0 \
  -i idempotency_key=invoice:additive-memo:v1 \
  --json
```

For durable local SQLite, omit `registry_store_id` at the lower-level
`data-store` boundary; this public graph intentionally requires it so harness
runs select isolated deterministic fixture stores. Production deployments bind
`registry_ref` to an operator-configured provider without changing this graph.

## Verification and harness cases

Use tested `runx-cli` **0.7.2 or newer**. The bounty floor is 0.6.14, but this
package consumes current canonical terminal-step contract behavior; the
known-failing `@runxhq/cli@0.6.19` path is unsupported.

Run the evaluator/projector tests and all package fixtures:

```bash
node --test skills/schema-guard/tests/*.test.mjs
runx harness ./skills/schema-guard --json
```

The reviewed Linux harness uses Node 22 Bookworm and the cached current binary
at `/target/debug/runx`, with `runx-schema-cargo-target:/target`. Put a wrapper
first on `PATH` that executes `node --disable-wasm-trap-handler`; do not use
`NODE_OPTIONS`.

Harness discovery yields five cases: two hosted inline cases plus three
standalone fixtures. The fixtures use unique local stores:

1. `additive-compatible-recorded` reads the immutable raw GitHub schema, adds
   optional `memo`, and must seal exactly `fetch-current`, `evaluate`,
   `append-version`, `readback`, and `project-result`.
2. `breaking-change-refused` reads the same immutable URL, changes
   `/properties/status/type` from `string` to `number`, and must be
   `policy_denied` after only `fetch-current` and `evaluate`.
3. `unreachable-source-refused` reads an allowlisted missing immutable path,
   fails, and must execute neither append, readback, nor projection. It remains
   standalone so the real unreachable URL is fetched; there is no hosted
   missing-input surrogate.

For the compatible receipt, inspect both the graph step list and receipt acts:
they must contain fetch, evaluate, append, readback, and project. Breaking
receipts contain only fetch/evaluate. The standalone unreachable receipt must
show the real URL failure and no append. Search refusal receipt JSON for
`append-version`, `append_event`, `readback`, and `project-result`; no such act
or committed event may exist.

## Security boundaries

The fetch can reach only caller-allowlisted hosts and re-checks redirects. The
evaluator has no network or registry authority. The registry write is an
append-only declared data-source operation with optimistic concurrency and an
idempotency key; model-authored raw queries are not supported. The readback is
bounded to the same resource and aggregate. Credentials, headers, cookies,
tokens, signing seeds, provider evidence, and unrestricted response bodies are
never copied into the terminal projection.
