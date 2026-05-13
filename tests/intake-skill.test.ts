import path from "node:path";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { runHarnessTarget } from "@runxhq/runtime-local/harness";
import { parseRunnerManifestYaml, validateRunnerManifest } from "@runxhq/core/parser";

describe("intake official skill", () => {
  it("ships as an explicit agent-task boundary with a generic triage report contract", async () => {
    const manifest = validateRunnerManifest(
      parseRunnerManifestYaml(await readFile(path.resolve("skills/intake/X.yaml"), "utf8")),
    );
    const runner = manifest.runners.intake;

    expect(runner?.source.type).toBe("agent-task");
    if (!runner || runner.source.type !== "agent-task") {
      throw new Error("intake runner must declare an agent-task source.");
    }

    expect(runner.source.task).toBe("intake");
    expect(runner.source.outputs).toEqual({
      triage_report: "object",
      change_set: "object",
    });
    expect(runner.inputs.thread_title?.type).toBe("string");
    expect(runner.inputs.thread_body?.type).toBe("string");
    expect(runner.inputs.thread_locator?.type).toBe("string");
    expect(runner.inputs.thread?.type).toBe("json");
    expect(runner.inputs.outbox_entry?.type).toBe("json");
    expect(runner.inputs.product_context?.type).toBe("string");
    expect(runner.inputs.operator_context?.type).toBe("string");
  });

  it("passes the inline harness suite, including supervisor-oriented gate examples", async () => {
    const result = await runHarnessTarget(path.resolve("skills/intake"));

    expect(result.source).toBe("inline");
    if (!("cases" in result)) {
      throw new Error("expected inline harness suite for intake");
    }
    expect(result.assertionErrors).toEqual([]);
    expect(result.cases.length).toBe(4);
    expect(result.cases.every((entry) => entry.status === "success")).toBe(true);
  });
});
