import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  validateExternalAdapterManifestContract,
  validateExternalAdapterResponseContract,
} from "./external-adapter.js";

// The examples consume the canonical extension SDK. These tests still spawn the
// real adapters the way the runtime does so package exports and wire framing are
// exercised together rather than only through an in-process helper test.
const examplesRoot = new URL("../../../../examples/", import.meta.url);

function runExampleAdapter(
  relativePath: string,
  invocation: unknown,
  env: NodeJS.ProcessEnv = {},
): unknown {
  const adapter = fileURLToPath(new URL(relativePath, examplesRoot));
  const result = spawnSync(process.execPath, [adapter], {
    input: JSON.stringify(invocation),
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  expect(result.status, result.stderr || result.error?.message).toBe(0);
  return JSON.parse(result.stdout) as unknown;
}

function invocation(
  invocationId: string,
  adapterId: string,
  inputs: Readonly<Record<string, unknown>>,
): unknown {
  return {
    schema: "runx.external_adapter.invocation.v1",
    protocol_version: "runx.external_adapter.v1",
    invocation_id: invocationId,
    adapter_id: adapterId,
    run_id: `run_${invocationId}`,
    step_id: "adapter",
    source_type: "external-adapter",
    skill_ref: "runx/example-external-adapter",
    harness_ref: { type: "harness", uri: `runx:harness:${invocationId}` },
    host_ref: { type: "host", uri: "runx:host:test" },
    inputs,
  };
}

describe("example external adapters emit contract-conformant response frames", () => {
  it("the openapi adapter manifest validates without self-attested authority", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../../../../examples/openapi-tool/manifest.json", import.meta.url), "utf8"),
    ) as unknown;
    const validated = validateExternalAdapterManifestContract(manifest);
    expect(validated.adapter_id).toBe("adapter.example.openapi");
    expect(validated.transport.kind).toBe("process");
  });

  it("the echo adapter emits a valid response frame", () => {
    const frame = runExampleAdapter(
      "external-adapter-tool/adapter.mjs",
      invocation("test-echo", "adapter.example.echo", { message: "hi" }),
    );
    const validated = validateExternalAdapterResponseContract(frame);
    expect(validated.schema).toBe("runx.external_adapter.response.v1");
    expect(validated.invocation_id).toBe("test-echo");
    expect(validated.adapter_id).toBe("adapter.example.echo");
  });

  it("the openapi adapter emits a valid response frame offline (dry-resolve fallback)", () => {
    const frame = runExampleAdapter(
      "openapi-tool/openapi-adapter.mjs",
      invocation("test-openapi", "adapter.example.openapi", {
        operation_id: "getPet",
        petId: "p-7",
      }),
      { RUNX_OPENAPI_BASE_URL: "http://127.0.0.1:9/v1" },
    );
    const validated = validateExternalAdapterResponseContract(frame);
    expect(validated.schema).toBe("runx.external_adapter.response.v1");
    expect(validated.invocation_id).toBe("test-openapi");
    expect(validated.status).toBe("completed");
    expect(validated.output).toMatchObject({
      ok: true,
      operation_id: "getPet",
      method: "GET",
      resolved_url: "http://127.0.0.1:9/v1/pets/p-7",
      executed: false,
    });
  });

  it("a failing adapter still emits a contract-conformant failed frame", () => {
    const frame = runExampleAdapter(
      "openapi-tool/openapi-adapter.mjs",
      invocation("test-openapi-fail", "adapter.example.openapi", {
        operation_id: "doesNotExist",
      }),
    );
    const validated = validateExternalAdapterResponseContract(frame);
    expect(validated.schema).toBe("runx.external_adapter.response.v1");
    expect(validated.status).toBe("failed");
  });
});
