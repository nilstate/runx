import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const runner = fileURLToPath(new URL("../run.mjs", import.meta.url));

const currentSchema = {
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

function inputs(overrides = {}) {
  return {
    fetch_result: {
      decision: "ready",
      status: 200,
      final_url: "https://schemas.example.test/invoice.json",
      content_digest: "sha256:source-content",
      extracted: JSON.stringify(currentSchema),
      headers: { authorization: "Bearer fetch-secret" },
    },
    proposed_schema: {
      ...structuredClone(currentSchema),
      properties: {
        ...structuredClone(currentSchema.properties),
        memo: { type: "string" },
      },
    },
    sample_payloads: [{ id: "inv-1", status: "paid" }],
    compatibility_policy: policy,
    expected_version: 3,
    idempotency_key: "schema-guard-invoice-v2",
    headers: { "x-secret": "input-header-secret" },
    token: "input-token-secret",
    ...overrides,
  };
}

function run(input, { env = {}, usePath = false } = {}) {
  const tempDir = usePath ? mkdtempSync(join(tmpdir(), "schema-guard-run-")) : null;
  const inputPath = tempDir ? join(tempDir, "inputs.json") : null;
  const childEnv = {
    ...process.env,
    RUNX_INPUTS_JSON: JSON.stringify(input),
    RUNX_RECEIPT_SIGN_ED25519_SEED_BASE64: "signer-seed-secret",
    ...env,
  };
  if (inputPath) {
    writeFileSync(inputPath, JSON.stringify(input));
    childEnv.RUNX_INPUTS_PATH = inputPath;
  } else {
    delete childEnv.RUNX_INPUTS_PATH;
  }
  try {
    return spawnSync(process.execPath, [runner], {
      env: childEnv,
      encoding: "utf8",
    });
  } finally {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  }
}

function parsedStdout(result) {
  assert.equal(result.stderr, "", `unexpected stderr: ${result.stderr}`);
  assert.notEqual(result.stdout.trim(), "");
  return JSON.parse(result.stdout);
}

test("emits the named compatible outputs from RUNX_INPUTS_JSON", () => {
  const result = run(inputs());
  assert.equal(result.status, 0, result.stderr);
  const output = parsedStdout(result);

  assert.deepEqual(Object.keys(output).sort(), [
    "compatibility",
    "expected_version",
    "idempotency_key",
    "migration_notes",
    "registry_event",
    "validation_results",
  ]);
  assert.equal(output.compatibility.compatible, true);
  assert.equal(output.registry_event.source.final_url, "https://schemas.example.test/invoice.json");
  assert.equal(output.registry_event.source.content_digest, "sha256:source-content");
  assert.equal(output.expected_version, 3);
  assert.equal(output.idempotency_key, "schema-guard-invoice-v2");
});

test("prefers RUNX_INPUTS_PATH over RUNX_INPUTS_JSON and accepts an object extracted schema", () => {
  const pathInput = inputs({
    fetch_result: {
      ...inputs().fetch_result,
      extracted: currentSchema,
    },
    expected_version: 8,
    idempotency_key: "from-inputs-path",
  });
  const result = run(pathInput, {
    usePath: true,
    env: { RUNX_INPUTS_JSON: JSON.stringify(inputs({ expected_version: 999 })) },
  });
  assert.equal(result.status, 0, result.stderr);
  const output = parsedStdout(result);
  assert.equal(output.expected_version, 8);
  assert.equal(output.idempotency_key, "from-inputs-path");
});

test("returns a successful governed refusal for a breaking proposal", () => {
  const proposedSchema = structuredClone(currentSchema);
  proposedSchema.properties.status = { type: "number" };
  const result = run(inputs({ proposed_schema: proposedSchema }));
  assert.equal(result.status, 0, result.stderr);
  const output = parsedStdout(result);
  assert.equal(output.compatibility.compatible, false);
  assert.equal(output.compatibility.breaking_changes[0].path, "/properties/status/type");
  assert.equal(output.registry_event, null);
});

test("fails closed for provider errors and non-2xx responses without a registry event", () => {
  for (const fetchResult of [
    { ...inputs().fetch_result, decision: "provider_error", status: 503 },
    { ...inputs().fetch_result, decision: "ready", status: 304 },
  ]) {
    const result = run(inputs({ fetch_result: fetchResult }));
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, "");
    assert.doesNotMatch(result.stderr, /fetch-secret|input-token-secret|signer-seed-secret/);
  }
});

test("fails closed for malformed fetched JSON and missing inputs", () => {
  const malformed = run(inputs({
    fetch_result: { ...inputs().fetch_result, extracted: "{not-json" },
  }));
  assert.notEqual(malformed.status, 0);
  assert.equal(malformed.stdout, "");

  const missing = spawnSync(process.execPath, [runner], {
    env: { ...process.env, RUNX_INPUTS_JSON: "", RUNX_INPUTS_PATH: "" },
    encoding: "utf8",
  });
  assert.notEqual(missing.status, 0);
  assert.equal(missing.stdout, "");
});

test("emits validation results and no registry event when a sample is invalid", () => {
  const result = run(inputs({ sample_payloads: [{ id: "inv-1", status: "unknown" }] }));
  assert.equal(result.status, 0, result.stderr);
  const output = parsedStdout(result);
  assert.equal(output.compatibility.compatible, false);
  assert.equal(output.validation_results[0].valid, false);
  assert.equal(output.registry_event, null);
});

test("rejects invalid expected_version and idempotency_key without leaking secrets", () => {
  for (const invalid of [
    { expected_version: -1 },
    { expected_version: 1.5 },
    { idempotency_key: "" },
    { idempotency_key: 42 },
  ]) {
    const result = run(inputs(invalid));
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, "");
    assert.doesNotMatch(result.stderr, /fetch-secret|input-token-secret|signer-seed-secret/);
  }
});

test("never serializes environment, headers, tokens, or signer seeds", () => {
  const result = run(inputs(), {
    env: {
      RUNX_PRIVATE_TOKEN: "private-token-secret",
      RUNX_SIGNER_SEED: "another-seed-secret",
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /fetch-secret|input-header-secret|input-token-secret|private-token-secret|another-seed-secret|signer-seed-secret/);
});
