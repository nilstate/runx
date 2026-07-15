import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

import { validateExternalAdapterManifestContract } from "../packages/contracts/src/index.js";

const stageDir = path.resolve("skills/spend/graph/pay-fulfill-rail");
const adapterPath = path.join(stageDir, "stripe-spt-fulfill-adapter.mjs");

describe("stripe-spt rail external adapter", () => {
  it("is wired as the pay-fulfill-rail stripe-spt runner", async () => {
    const manifest = parseYaml(await readFile(path.join(stageDir, "X.yaml"), "utf8")) as {
      readonly runners: Readonly<Record<string, {
        readonly source?: unknown;
        readonly runx?: { readonly payment_authority?: unknown };
      }>>;
    };
    const runner = manifest.runners["stripe-spt"];

    expect(runner?.source).toMatchObject({ type: "external-adapter" });
    expect(runner?.source).toMatchObject({ external_adapter: {
      manifest_path: "stripe-spt-fulfill-adapter.manifest.json",
    } });
    expect(runner?.runx?.payment_authority).toMatchObject({
      phase: "fulfill",
      rails: ["stripe-spt"],
      receipt_before_success: true,
    });
  });

  it("validates the stage-local external-adapter manifest", async () => {
    const manifest = JSON.parse(
      await readFile(path.join(stageDir, "stripe-spt-fulfill-adapter.manifest.json"), "utf8"),
    );

    expect(validateExternalAdapterManifestContract(manifest).schema).toBe(
      "runx.external_adapter.manifest.v1",
    );
    expect(manifest.transport.args).toEqual(["stripe-spt-fulfill-adapter.mjs"]);
    expect(manifest.sandbox_intent).toMatchObject({
      profile: "network",
      cwd_policy: "skill-directory",
      network: true,
    });
  });

  it("executes the Stripe SPT executor with kernel-admission-bound scope", () => {
    const response = invokeAdapter(adapterInputs());
    const output = requireRecord(response.output, "response.output");

    expect(response.status).toBe("completed");
    expect(output.rail_result).toMatchObject({
      status: "fulfilled",
      rail: "stripe-spt",
      amount_minor: 125,
      currency: "USD",
      counterparty: "merchant:demo",
      money_movement_id: "sha256:money-movement",
      admission_token_digest: "sha256:kernel-token",
      usage_limit_amount_minor: 125,
      usage_limit_currency: "USD",
      payment_intent_id: "pi_test_sha256_money_movement",
      charge_id: "ch_test_sha256_money_movement",
      shared_payment_token_id: "spt_test_sha256_money_movement",
    });
    expect(output.rail_proof).toMatchObject({
      idempotency_key: "payment:test-1",
      payment_admission_id: "sha256:payment-admission",
      money_movement_id: "sha256:money-movement",
      kernel_token_digest: "sha256:kernel-token",
    });
    expect(output.credential_envelope).toMatchObject({
      form: "stripe_spt_scoped_token",
      usage_limit_amount_minor: 125,
      usage_limit_currency: "USD",
      admission_token_digest: "sha256:kernel-token",
    });
    expect(output.settlement_proof).toMatchObject({
      payment_admission_id: "sha256:payment-admission",
      money_movement_id: "sha256:money-movement",
      kernel_token_digest: "sha256:kernel-token",
      proof_status: "fulfilled",
    });
  });

  it("fails closed when admission scope differs from the payment challenge", () => {
    const inputs = adapterInputs();
    const paymentAdmission = requireRecord(inputs.payment_admission, "payment_admission");
    const token = requireRecord(paymentAdmission.token, "payment_admission.token");
    const response = invokeAdapter({
      ...inputs,
      payment_admission: {
        ...paymentAdmission,
        token: {
          ...token,
          amount_minor: 126,
        },
      },
    });

    expect(response.status).toBe("failed");
    expect(response.stderr).toContain("payment admission amount does not match");
  });

  it("refuses a local live profile instead of reading ambient Stripe secrets", () => {
    const response = invokeAdapter({
      ...adapterInputs(),
      rail_profile_ref: "rail-profile:stripe-spt:live",
    });

    expect(response.status).toBe("failed");
    expect(response.stderr).toContain("requires a hosted payment provider");
  });
});

function adapterInputs(): Record<string, unknown> {
  return {
    payment_challenge: {
      rail: "stripe-spt",
      amount_minor: 125,
      currency: "USD",
      counterparty: "merchant:demo",
      operation: "search.paid",
    },
    payment_admission: {
      payment_admission_id: "sha256:payment-admission",
      money_movement_id: "sha256:money-movement",
      kernel_token_digest: "sha256:kernel-token",
      token_digest: "sha256:kernel-token",
      token: {
        rail: "stripe-spt",
        amount_minor: 125,
        currency: "USD",
        counterparty: "merchant:demo",
      },
    },
    idempotency: {
      key: "payment:test-1",
    },
    rail_profile_ref: "rail-profile:stripe-spt:test",
  };
}

function invokeAdapter(inputs: Record<string, unknown>): Record<string, unknown> {
  const result = spawnSync(process.execPath, [adapterPath], {
    cwd: stageDir,
    env: process.env,
    input: JSON.stringify({
      schema: "runx.external_adapter.invocation.v1",
      protocol_version: "runx.external_adapter.v1",
      invocation_id: "stripe_spt_fulfill_test.invoke",
      adapter_id: "runx.payment.stripe_spt.fulfill",
      run_id: "stripe_spt_fulfill_test",
      step_id: "fulfill",
      source_type: "external-adapter",
      skill_ref: "runx/spend/pay-fulfill-rail",
      harness_ref: { type: "harness", uri: "runx:harness:stripe_spt_fulfill_test" },
      host_ref: { type: "host", uri: "runx:host:test" },
      inputs,
    }),
    encoding: "utf8",
  });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}
