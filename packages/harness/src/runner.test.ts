import { describe, expect, it } from "vitest";

import { parseHarnessFixture, runHarness, runHarnessTarget } from "./runner.js";

describe("harness runner", () => {
  it("parses fixture shape and caller traces", () => {
    const fixture = parseHarnessFixture(`
name: echo-fixture
kind: skill
target: ../skills/echo
inputs:
  message: hello
caller:
  answers:
    fallback: value
  approvals:
    gate: true
expect:
  status: success
  receipt:
    kind: skill_execution
    subject:
      skill_name: echo
`);

    expect(fixture.name).toBe("echo-fixture");
    expect(fixture.kind).toBe("skill");
    expect(fixture.inputs).toEqual({ message: "hello" });
    expect(fixture.caller.answers).toEqual({ fallback: "value" });
    expect(fixture.caller.approvals).toEqual({ gate: true });
  });

  it("runs an echo skill fixture and asserts receipt shape", async () => {
    const result = await runHarness("fixtures/harness/echo-skill.yaml");

    expect(result.status).toBe("success");
    expect(result.assertionErrors).toEqual([]);
    expect(result.receipt?.kind).toBe("skill_execution");
    if (result.receipt?.kind !== "skill_execution") {
      return;
    }
    expect(result.receipt.subject.skill_name).toBe("echo");
    expect(result.trace.events.map((event) => event.type)).toContain("completed");
  });

  it("runs a sequential chain fixture and asserts linked receipts", async () => {
    const result = await runHarness("fixtures/harness/sequential-chain.yaml");

    expect(result.status).toBe("success");
    expect(result.assertionErrors).toEqual([]);
    expect(result.chainReceipt?.kind).toBe("chain_execution");
    expect(result.chainReceipt?.steps.map((step) => step.step_id)).toEqual(["first", "second"]);
    expect(result.chainReceipt?.steps[1]?.parent_receipt).toBe(result.chainReceipt?.steps[0]?.receipt_id);
  });

  it(
    "runs inline harness cases from a skill directory",
    async () => {
      const result = await runHarnessTarget("skills/evolve");

      expect(result.source).toBe("inline");
      if (!("cases" in result)) {
        throw new Error("expected inline harness suite");
      }
      expect(result.status).toBe("success");
      expect(result.assertionErrors).toEqual([]);
      expect(result.cases.map((entry) => entry.fixture.name)).toEqual(["evolve-introspect", "evolve-plan-spec"]);
      expect(result.cases[0]?.status).toBe("success");
      expect(result.cases[0]?.receipt?.kind).toBe("chain_execution");
      expect(result.cases[1]?.receipt?.kind).toBe("chain_execution");
    },
    15_000,
  );
});
