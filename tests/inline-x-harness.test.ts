import { describe, expect, it } from "vitest";

import { runHarnessTarget } from "@runxhq/core/harness";

describe("inline x harness", () => {
  it("runs the evolve inline harness suite successfully", async () => {
    const result = await runHarnessTarget("skills/evolve");

    expect(result.source).toBe("inline");
    if (!("cases" in result)) {
      throw new Error("expected inline harness suite");
    }
    expect(result.status).toBe("success");
    expect(result.assertionErrors).toEqual([]);
    expect(result.cases.map((entry) => entry.fixture.name)).toEqual(["evolve-introspect", "evolve-plan-spec"]);
    expect(result.cases[0]?.receipt?.kind).toBe("graph_execution");
    expect(result.cases[1]?.receipt?.kind).toBe("graph_execution");
  }, 15_000);

  it("runs the Sourcey inline harness suite through the skill package", async () => {
    const result = await runHarnessTarget("skills/sourcey");

    expect(result.source).toBe("inline");
    if (!("cases" in result)) {
      throw new Error("expected inline harness suite");
    }
    expect(result.status).toBe("success");
    expect(result.assertionErrors).toEqual([]);
    expect(result.cases.map((entry) => entry.fixture.name)).toEqual([
      "sourcey-discovery-yield",
      "sourcey-needs-project-input",
    ]);
    expect(result.cases[0]?.status).toBe("needs_resolution");
    expect(result.cases[1]?.status).toBe("needs_resolution");
  });
});
