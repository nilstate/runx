import path from "node:path";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { runHarnessTarget } from "../packages/harness/src/index.js";
import { parseRunnerManifestYaml, validateRunnerManifest } from "../packages/parser/src/index.js";

describe("support-triage official skill", () => {
  it("ships as an explicit agent-step boundary with a generic triage report contract", async () => {
    const manifest = validateRunnerManifest(
      parseRunnerManifestYaml(await readFile(path.resolve("skills/support-triage/X.yaml"), "utf8")),
    );
    const runner = manifest.runners.triage;

    expect(runner?.source.type).toBe("agent-step");
    if (!runner || runner.source.type !== "agent-step") {
      throw new Error("support-triage runner must declare an agent-step source.");
    }

    expect(runner.source.task).toBe("support-triage");
    expect(runner.source.outputs).toEqual({
      triage_report: "object",
      change_set: "object",
    });
    expect(runner.inputs.title?.type).toBe("string");
    expect(runner.inputs.issue_title?.type).toBe("string");
    expect(runner.inputs.body?.type).toBe("string");
    expect(runner.inputs.issue_body?.type).toBe("string");
    expect(runner.inputs.product_context?.type).toBe("string");
    expect(runner.inputs.operator_context?.type).toBe("string");
  });

  it("passes the inline harness suite, including supervisor-oriented gate examples", async () => {
    const result = await runHarnessTarget(path.resolve("skills/support-triage"));

    expect(result.source).toBe("inline");
    if (!("cases" in result)) {
      throw new Error("expected inline harness suite for support-triage");
    }
    expect(result.assertionErrors).toEqual([]);
    expect(result.cases.length).toBe(4);
    expect(result.cases.every((entry) => entry.status === "success")).toBe(true);
  });
});
