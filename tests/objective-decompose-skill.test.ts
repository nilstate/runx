import path from "node:path";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { runHarnessTarget } from "../packages/harness/src/index.js";
import { parseRunnerManifestYaml, validateRunnerManifest } from "../packages/parser/src/index.js";

describe("objective-decompose official skill", () => {
  it("ships as an explicit agent-step boundary with phased workspace-plan outputs", async () => {
    const manifest = validateRunnerManifest(
      parseRunnerManifestYaml(await readFile(path.resolve("skills/objective-decompose/X.yaml"), "utf8")),
    );
    const runner = manifest.runners["objective-decompose-agent"];

    expect(runner?.source.type).toBe("agent-step");
    if (!runner || runner.source.type !== "agent-step") {
      throw new Error("objective-decompose runner must declare an agent-step source.");
    }

    expect(runner.source.task).toBe("objective-decomposition");
    expect(runner.source.outputs).toEqual({
      change_set: "object",
      objective_summary: "string",
      workspace_change_plan: "object",
      orchestration_steps: "array",
      required_skills: "array",
      open_questions: "array",
    });
    expect(runner.inputs.objective?.type).toBe("string");
    expect(runner.inputs.project_context?.type).toBe("string");
    expect(runner.inputs.change_set?.type).toBe("object");
  });

  it("passes the inline harness suite, including phased multi-repo decomposition", async () => {
    const result = await runHarnessTarget(path.resolve("skills/objective-decompose"));

    expect(result.source).toBe("inline");
    if (!("cases" in result)) {
      throw new Error("expected inline harness suite for objective-decompose");
    }
    expect(result.assertionErrors).toEqual([]);
    expect(result.cases.length).toBe(2);
    expect(result.cases.every((entry) => entry.status === "success")).toBe(true);
  });
});
