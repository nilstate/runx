import { describe, expect, it } from "vitest";

import { createDefaultSkillAdapters } from "@runxhq/adapters";
import { runHarnessTarget } from "@runxhq/runtime-local/harness";

describe("hello-graph example", () => {
  it("runs through the graph harness", async () => {
    const result = await runHarnessTarget("examples/hello-graph/harness.yaml", { adapters: createDefaultSkillAdapters() });

    expect(result.source).toBe("fixture");
    if (result.source !== "fixture") {
      throw new Error("expected hello-graph harness.yaml to run as a single fixture");
    }
    expect(result.status).toBe("success");
    expect(result.assertionErrors).toEqual([]);
    expect(result.graphReceipt?.kind).toBe("graph_execution");
    expect(result.graphReceipt?.graph_name).toBe("hello-graph");
  });
});
