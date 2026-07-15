# Schema Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish and deliver the exact `schema-guard` runx skill for Frantic bounty #84 with a real source read, a consumed schema-registry write, production Ed25519 receipts, and reproducible evidence.

**Architecture:** A runx graph composes the canonical `web-fetch` and `data-store` skills around a deterministic Node.js compatibility evaluator. Compatible changes append and read back a `schema_registry_versions` event; breaking or invalid changes stop before the append. Unit tests exercise the evaluator and runner, while runx harness and post-publish dogfood prove the governed source/effect path.

**Tech Stack:** Node.js 20+, ESM, `node:test`, YAML runx graph definitions, runx CLI 0.6.14+, canonical `web-fetch` and `data-store` skills, Ed25519 receipt signing.

## Global Constraints

- Exact package name: `schema-guard`.
- Work from current `runxhq/runx` `main`; the PR may add only the design/plan and `skills/schema-guard` package/evidence files.
- Dogfood reads the current schema from an immutable public HTTPS URL at run time.
- Compatible dogfood executes a `data-store append_event` and readback in the same graph run.
- Breaking, malformed, and unreachable inputs execute no registry append.
- Receipt issuer type is `hosted`; local-development and runtime-skeleton receipts are forbidden delivery evidence.
- All public URLs, package metadata, evidence, report, receipt, and PR files identify one commit and one registry version.
- Registry packages do not include sibling skills. Vendor pinned canonical
  `web-fetch` and `data-store` packages inside `skills/schema-guard/graph/` and
  reference those package-local paths so a clean install remains executable.

---

### Task 1: Deterministic compatibility evaluator

**Files:**
- Create: `skills/schema-guard/core.mjs`
- Create: `skills/schema-guard/tests/core.test.mjs`

**Interfaces:**
- Produces: `evaluateSchemaChange({ currentSchema, proposedSchema, samplePayloads, policy, source })` returning `{ compatibility, validation_results, migration_notes, registry_event }`.
- Produces: `canonicalJson(value)` and `sha256Json(value)` for stable verdict and event digests.

- [ ] **Step 1: Write failing evaluator tests**

Create `skills/schema-guard/tests/core.test.mjs` with `node:test` cases for:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { evaluateSchemaChange } from "../core.mjs";

const current = {
  $id: "invoice-v1",
  type: "object",
  required: ["id", "status"],
  properties: {
    id: { type: "string" },
    status: { type: "string", enum: ["draft", "paid"] },
  },
};
const policy = {
  breaking_allowed: false,
  required_fields: ["id", "status"],
  versioning_rule: "semver_minor_for_additive",
};

test("accepts an additive optional property and emits a registry event", () => {
  const proposed = structuredClone(current);
  proposed.properties.memo = { type: "string" };
  const result = evaluateSchemaChange({
    currentSchema: current,
    proposedSchema: proposed,
    samplePayloads: [{ id: "inv-1", status: "paid" }],
    policy,
    source: { final_url: "https://example.test/invoice.json", content_digest: "sha256:source" },
  });
  assert.equal(result.compatibility.compatible, true);
  assert.equal(result.compatibility.breaking_changes.length, 0);
  assert.equal(result.registry_event.type, "schema.version.recorded");
});

test("reports field path old contract new contract and rule for a type change", () => {
  const proposed = structuredClone(current);
  proposed.properties.status = { type: "number" };
  const result = evaluateSchemaChange({ currentSchema: current, proposedSchema: proposed, samplePayloads: [], policy, source: {} });
  assert.equal(result.compatibility.compatible, false);
  assert.deepEqual(result.compatibility.breaking_changes[0], {
    path: "/properties/status/type",
    old_contract: "string",
    new_contract: "number",
    policy_rule: "property_type_must_not_change",
  });
  assert.equal(result.registry_event, null);
});
```

Add separate tests for removed properties, optional-to-required changes, enum
narrowing, enum widening, malformed schemas, payload validation, empty sample
coverage, and deterministic verdict digests.

- [ ] **Step 2: Run tests and confirm RED**

Run: `node --test skills/schema-guard/tests/core.test.mjs`

Expected: failure because `skills/schema-guard/core.mjs` does not exist.

- [ ] **Step 3: Implement the evaluator**

Implement focused helpers in `core.mjs`:

```js
export function evaluateSchemaChange({ currentSchema, proposedSchema, samplePayloads = [], policy, source }) {
  assertObjectSchema(currentSchema, "current_schema");
  assertObjectSchema(proposedSchema, "proposed_schema");
  const breakingChanges = compareObjectSchemas(currentSchema, proposedSchema, policy);
  const validationResults = samplePayloads.map((payload, index) => validatePayload(proposedSchema, payload, index));
  const compatibility = {
    compatible: breakingChanges.length === 0 || policy.breaking_allowed === true,
    breaking_changes: breakingChanges,
    sample_coverage_supplied: samplePayloads.length > 0,
  };
  compatibility.verdict_digest = sha256Json({ compatibility, validation_results: validationResults });
  const migrationNotes = migrationNotesFor(currentSchema, proposedSchema, breakingChanges);
  return {
    compatibility,
    validation_results: validationResults,
    migration_notes: migrationNotes,
    registry_event: compatibility.compatible ? registryEvent({ proposedSchema, source, compatibility, validationResults }) : null,
  };
}
```

`compareObjectSchemas` must emit one object per violation with exactly
`path`, `old_contract`, `new_contract`, and `policy_rule`. `validatePayload`
must check declared required fields, primitive types, and enums without
claiming coverage for unsupplied samples.

- [ ] **Step 4: Run evaluator tests and confirm GREEN**

Run: `node --test skills/schema-guard/tests/core.test.mjs`

Expected: all evaluator tests pass with zero failures.

- [ ] **Step 5: Commit evaluator**

```bash
git add skills/schema-guard/core.mjs skills/schema-guard/tests/core.test.mjs
git commit -s -m "feat(schema-guard): add deterministic compatibility evaluator"
```

### Task 2: Governed evaluator runner

**Files:**
- Create: `skills/schema-guard/run.mjs`
- Create: `skills/schema-guard/tests/run.test.mjs`

**Interfaces:**
- Consumes: `RUNX_INPUTS_JSON` containing `fetch_result`, `proposed_schema`, `sample_payloads`, and `compatibility_policy`.
- Produces stdout JSON with named outputs `compatibility`, `validation_results`, `migration_notes`, `registry_event`, `expected_version`, and `idempotency_key`.

- [ ] **Step 1: Write failing subprocess tests**

Use `spawnSync(process.execPath, [runner])` with `RUNX_INPUTS_JSON`. Assert that
a ready `fetch_result.extracted` JSON string produces named outputs, while
`provider_error`, malformed fetched JSON, and a breaking proposal exit nonzero
or produce no `registry_event` as specified by the graph policy.

- [ ] **Step 2: Run tests and confirm RED**

Run: `node --test skills/schema-guard/tests/run.test.mjs`

Expected: failure because `run.mjs` does not exist.

- [ ] **Step 3: Implement the runner**

The runner must parse `RUNX_INPUTS_PATH` when present, otherwise
`RUNX_INPUTS_JSON`; require `fetch_result.decision === "ready"` and HTTP 2xx;
parse `fetch_result.extracted` as JSON; call `evaluateSchemaChange`; and emit:

```js
process.stdout.write(`${JSON.stringify({
  compatibility: result.compatibility,
  validation_results: result.validation_results,
  migration_notes: result.migration_notes,
  registry_event: result.registry_event,
  expected_version: inputs.expected_version,
  idempotency_key: inputs.idempotency_key,
})}\n`);
```

Never include environment variables, headers, tokens, or signer seeds in output.

- [ ] **Step 4: Run runner and evaluator tests**

Run: `node --test skills/schema-guard/tests/*.test.mjs`

Expected: all tests pass.

- [ ] **Step 5: Commit runner**

```bash
git add skills/schema-guard/run.mjs skills/schema-guard/tests/run.test.mjs
git commit -s -m "feat(schema-guard): add governed evaluator runner"
```

### Task 3: Graph composition, typed contract, and harness

**Files:**
- Create: `skills/schema-guard/X.yaml`
- Create: `skills/schema-guard/SKILL.md`
- Create: `skills/schema-guard/fixtures/additive-compatible-recorded.yaml`
- Create: `skills/schema-guard/fixtures/breaking-change-refused.yaml`
- Create: `skills/schema-guard/fixtures/unreachable-source-refused.yaml`
- Create: `skills/schema-guard/fixtures/current-invoice.schema.json`
- Create: `skills/schema-guard/graph/web-fetch/**` from the canonical pinned package
- Create: `skills/schema-guard/graph/data-store/**` from the canonical pinned package

**Interfaces:**
- Consumes the public inputs documented by the design.
- Produces evaluator outputs plus `data_operation_result` append/readback packets on the compatible path.

- [ ] **Step 1: Add the harness cases before the graph exists**

The compatible fixture must use a local fixture HTTP URL or immutable raw URL,
`source_allowlist`, an additive proposal, a fresh `registry_store_id`, and
expect `status: sealed`. The breaking fixture changes `/properties/status/type`
and expects graph failure/refusal. The unreachable fixture uses an allowlisted
unreachable URL and expects failure with no append.

- [ ] **Step 2: Run harness and confirm RED**

Run: `runx harness ./skills/schema-guard --json`

Expected: failure because `X.yaml` and the runner contract are absent.

- [ ] **Step 3: Implement `X.yaml` graph**

Create the exact `skill: schema-guard`, version `0.1.0`, typed runner inputs,
and these ordered steps:

```yaml
steps:
  - id: fetch-current
    skill: graph/web-fetch
    runner: web-fetch
    inputs:
      url: "$input.source_url"
      allowlist: "$input.source_allowlist"
      extract: text
  - id: evaluate
    run:
      type: cli-tool
      command: node
      args: [run.mjs]
      outputs:
        compatibility: object
        validation_results: object
        migration_notes: object
        registry_event: object
        expected_version: number
        idempotency_key: string
    context:
      fetch_result: fetch-current.fetch_result.data
  - id: append-version
    skill: graph/data-store
    runner: append_event
    inputs:
      data_source_ref: "$input.registry_ref"
      store_id: "$input.registry_store_id"
      resource: schema_registry_versions
      aggregate_id: "$input.schema_id"
    context:
      expected_version: evaluate.expected_version.data
      idempotency_key: evaluate.idempotency_key.data
      event: evaluate.registry_event.data
  - id: readback
    skill: graph/data-store
    runner: read_projection
    inputs:
      data_source_ref: "$input.registry_ref"
      store_id: "$input.registry_store_id"
      resource: schema_registry_versions
      aggregate_id: "$input.schema_id"
policy:
  guards:
    - step: append-version
      field: evaluate.compatibility.data.compatible
      equals: true
```

Declare all evaluator outputs in the runner, and document that the append and
readback packets form `publish_result`. Ensure graph context contains the
proposed schema, samples, policy, version, and idempotency values.

- [ ] **Step 4: Write `SKILL.md`**

Document exact inputs/outputs, compatibility rules, refusal behavior, source
allowlisting, schema-registry effect, install/run/verify commands, and a worked
example. Do not claim support beyond object-shaped JSON Schema/OpenAPI component
schemas.

- [ ] **Step 5: Run parser, unit tests, and local harness**

```bash
node --test skills/schema-guard/tests/*.test.mjs
runx harness ./skills/schema-guard --json
pnpm authoring:check-package-contract
```

Expected: unit tests and all three harness cases pass; the compatible receipt
contains fetch, append, and readback acts; refused cases contain no append act.

- [ ] **Step 6: Commit graph package**

```bash
git add skills/schema-guard
git commit -s -m "feat(schema-guard): compose source read and registry effect"
```

### Task 4: Production-signed dogfood and evidence capture

**Files:**
- Create: `skills/schema-guard/evidence/evidence.json`
- Create: `skills/schema-guard/evidence/verification.json`
- Create: `skills/schema-guard/evidence/harness-summary.json`
- Create: `skills/schema-guard/evidence/REPORT.md`
- Create: `skills/schema-guard/evidence/dogfood-input.json`
- Create outside the repository: `C:/Users/ASUS/.codex/private/schema-guard-signer.json`

**Interfaces:**
- Produces a production Ed25519 signer seed/public key pair outside git for
  local harness integrity checks only.
- The final delivery receipt must come from a real post-publish hosted run and
  must not contain `local_runtime` or `runtime-skeleton-enforcement` authority.

- [ ] **Step 1: Generate signer material outside the repository**

Use Node `crypto.randomBytes(32)`, derive the Ed25519 public key from the PKCS#8
seed, and write only the private JSON file containing `kid`, `seed_base64`, and
`public_key_base64`. Confirm `git grep` cannot find the seed.

- [ ] **Step 2: Run local harness with production signer variables**

Set:

```text
RUNX_RECEIPT_SIGN_KID=schema-guard-qq2401672073-hub-20260715
RUNX_RECEIPT_SIGN_ED25519_SEED_BASE64=$signer.seed_base64
RUNX_RECEIPT_SIGN_ISSUER_TYPE=hosted
RUNX_RECEIPT_VERIFY_KID=schema-guard-qq2401672073-hub-20260715
RUNX_RECEIPT_VERIFY_ED25519_PUBLIC_KEY_BASE64=$signer.public_key_base64
```

Run `runx harness ./skills/schema-guard --json` and save the structured summary.

- [ ] **Step 3: Run real-source dogfood**

Use an immutable raw GitHub JSON Schema URL and complete `--input-json` values.
The command must execute the compatible append/readback path in a fresh store.
Capture stdout and the runtime receipt path.

- [ ] **Step 4: Verify the receipt in production mode**

Run `runx verify --receipt $dogfoodReceipt --json` with the public verification
variables. Save the exact returned JSON as `verification.json`. Assert:

- `valid === true`;
- issuer type is `hosted`;
- signature mode is not `local-development`;
- acts include the real web source read, registry append, and readback;
- no signer seed or token appears in any tracked artifact.

This local signed run is pre-publish validation, not the final hosted dogfood
receipt.

- [ ] **Step 5: Build evidence and report**

`evidence.json.dogfood` must contain exact `package`, complete `input`, runnable
`command`, post-publish `receipt_ref`, full `verify_verdict`, and
`harness_cases`. Its observations must include every #84 acceptance item,
including source read, compatibility, breaking changes, validation results,
sealed publish result, hosted harness, and receipt id.

- [ ] **Step 6: Commit evidence without secrets**

```bash
git add skills/schema-guard/evidence
git diff --cached --check
git grep -n -E "seed_base64|agent_token|github_pat_|ghp_"
git commit -s -m "test(schema-guard): publish reproducible governed evidence"
```

### Task 5: Registry publication and clean consumer verification

**Files:**
- Modify evidence files only if the registry version or immutable URLs require final binding.

- [ ] **Step 1: Run complete pre-publish verification**

```bash
node --test skills/schema-guard/tests/*.test.mjs
runx harness ./skills/schema-guard --json
pnpm authoring:check-package-contract
git diff --check
```

- [ ] **Step 2: Publish exact package**

Run with the existing purpose-scoped publish credential:

```bash
runx registry publish ./skills/schema-guard/SKILL.md --registry https://api.runx.ai
runx registry read qq2401672073-hub/schema-guard@0.1.0 --json
```

- [ ] **Step 3: Verify hosted harness and live listing**

Require HTTP 200 for the pinned registry listing and a green hosted harness.
If either fails, stop delivery and repair/re-publish rather than submitting a
known red artifact.

- [ ] **Step 4: Clean install and post-publish dogfood**

In a fresh temporary directory install the package, then pass each top-level
field in `dogfood-input.json` as a separate `--input-json key=<json>` argument:

```bash
runx add qq2401672073-hub/schema-guard@0.1.0
runx skill qq2401672073-hub/schema-guard@0.1.0 \
  --input-json source_url='"https://..."' \
  --input-json source_allowlist='["raw.githubusercontent.com"]' \
  --input-json proposed_schema='{...}' \
  --input-json sample_payloads='[...]' \
  --input-json compatibility_policy='{...}' \
  --json
runx verify --receipt "$dogfoodReceipt" --json
```

Submit the same complete input to the hosted run API, poll it to completion,
fetch the platform receipt, and verify that receipt. Replace pre-publish local
receipt evidence with this real post-publish hosted receipt and preserve the
actual request/response capture without credentials.

- [ ] **Step 5: Commit final immutable bindings**

Update every artifact to the same package version and commit SHA, rerun the
secret scan and JSON parsing, then commit with
`test(schema-guard): bind published package evidence`.

### Task 6: GitHub PR, Frantic delivery, and review tracking

**Files:**
- No new implementation files; this task publishes the verified branch and delivery packet.

- [ ] **Step 1: Rebase onto current upstream main and inspect scope**

```bash
git fetch upstream main
git rebase upstream/main
git diff --name-status upstream/main...HEAD
```

Expected: only the schema-guard design/plan and `skills/schema-guard/**`; no
unrelated deletion or modification.

- [ ] **Step 2: Run final verification after rebase**

Rerun unit tests, local harness, clean install, production receipt verify,
hosted harness, URL checks, JSON parsing, secret scan, and `git diff --check`.

- [ ] **Step 3: Push and open the public PR**

Push `agent/schema-guard` to `qq2401672073-hub/runx` and open a PR against
`runxhq/runx:main`. The PR body lists the real source read, consumed registry
effect, refusal behavior, test results, hosted harness result, and production
receipt verification.

- [ ] **Step 4: Preflight Frantic artifact bindings**

Bind `public_url`, `source_url`, `pr_url`, raw pinned `x_yaml`, raw pinned
`skill_md`, `verification_json`, `evidence_json`, `receipt_ref`, and `report`.
POST to `/v1/deliveries/preflight` and require `ok: true` with no warnings.

- [ ] **Step 5: Deliver and track every gate**

POST the same packet to `/v1/deliveries`, then poll agent status until machine
verification, auto-review, and human judgment finish. On a revision result,
write a failing regression test for the concrete defect, fix, reverify, and
redeliver within the claim window.
