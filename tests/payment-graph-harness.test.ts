import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { runCli } from "../packages/cli/src/index.js";

const rustKernelBin = path.resolve(
  "crates",
  "target",
  "debug",
  process.platform === "win32" ? "runx.exe" : "runx",
);
const graphSkills = [
  { skill: "charge", stepIds: ["price", "challenge", "verify", "seal", "forward"] },
  { skill: "mock-pay", stepIds: ["spend"] },
  { skill: "mpp-pay", stepIds: ["spend"] },
  { skill: "refund", stepIds: ["quote", "reserve", "approve-refund", "settlement"] },
  { skill: "spend", stepIds: ["quote", "reserve", "approve-spend", "fulfill"] },
  { skill: "stripe-pay", stepIds: ["spend"] },
  { skill: "x402-pay", stepIds: ["spend"] },
];
const graphHarnessCaseCounts = new Map([
  ["mock-pay", 1],
  ["mpp-pay", 1],
]);
const graphFixtureCounts = new Map([
  ["charge", 3],
  ["refund", 3],
  ["spend", 4],
  ["stripe-pay", 1],
  ["x402-pay", 1],
]);
const graphStepCounts = new Map([
  ["charge", 15],
  ["mock-pay", 1],
  ["mpp-pay", 1],
  ["refund", 12],
  ["spend", 16],
  ["stripe-pay", 1],
  ["x402-pay", 1],
]);

describe("canonical payment graph profiles", () => {
  it.each(graphSkills)("$skill profile is native-discoverable and declares graph runners", async ({ skill, stepIds: expectedStepIds }) => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), `runx-${skill}-profile-`));
    const stdout = createMemoryStream();
    const stderr = createMemoryStream();

    try {
      const profile = await readPaymentProfile(skill);
      expect(profile).toMatch(/^\s+type: graph$/m);
      expect(stepIds(profile)).toEqual(expectedStepIds);

      const exitCode = await runCli(
        ["list", "graphs", "--json"],
        { stdin: process.stdin, stdout, stderr },
        {
          ...paymentHarnessEnv(),
          RUNX_CWD: process.cwd(),
          RUNX_HOME: path.join(tempDir, "home"),
        },
      );

      expect(exitCode, stderr.contents()).toBe(0);
      expect(stderr.contents()).toBe("");
      const report = requireRecord(JSON.parse(stdout.contents()), "list report");
      const items = requireArray(report.items, "list report items").map((entry) => requireRecord(entry, "list item"));
      expect(items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "graph",
            name: skill,
            status: "ok",
            fixtures: graphFixtureCounts.get(skill) ?? 0,
            harness_cases: graphHarnessCaseCounts.get(skill) ?? 0,
            steps: graphStepCounts.get(skill) ?? expectedStepIds.length,
          }),
        ]),
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 20_000);
});

async function readPaymentProfile(skill: string): Promise<string> {
  return await readFile(path.join("skills", skill, "X.yaml"), "utf8");
}

function stepIds(profile: string): readonly string[] {
  return [...new Set([...profile.matchAll(/^\s+- id: ([a-z0-9-]+)$/gm)].map((match) => match[1]))];
}

function paymentHarnessEnv(): NodeJS.ProcessEnv {
  const configured = process.env.RUNX_KERNEL_EVAL_BIN;
  const kernelBin = configured && configured.length > 0
    ? configured
    : existsSync(rustKernelBin)
      ? rustKernelBin
      : undefined;
  if (!kernelBin) {
    throw new Error(
      "payment graph profiles require RUNX_KERNEL_EVAL_BIN or a built crates/target/debug/runx binary.",
    );
  }
  return {
    ...process.env,
    RUNX_KERNEL_EVAL_BIN: kernelBin,
  };
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array.`);
  }
  return value;
}

function createMemoryStream(): NodeJS.WriteStream & { contents: () => string } {
  let buffer = "";
  return {
    write: (chunk: string | Uint8Array) => {
      buffer += chunk.toString();
      return true;
    },
    contents: () => buffer,
  } as NodeJS.WriteStream & { contents: () => string };
}
