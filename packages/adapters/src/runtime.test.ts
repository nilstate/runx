import { describe, expect, it, vi } from "vitest";

import type { ResolutionRequest } from "@runxhq/core/executor";

vi.mock("./agent/index.js", () => ({
  executeManagedAgentResolution: vi.fn(async () => ({ actor: "agent", payload: { echoed: "managed" } })),
  loadManagedAgentConfig: vi.fn(async () => ({ provider: "openai", model: "gpt-5.1" })),
}));

const { createRuntimeBackedCaller } = await import("./runtime.js");
const { executeManagedAgentResolution, loadManagedAgentConfig } = await import("./agent/index.js");

describe("createRuntimeBackedCaller", () => {
  it("uses provided answers before managed runtime resolution", async () => {
    const caller = createRuntimeBackedCaller({
      answers: {
        "agent_step.docs-build.output": {
          project_brief: { summary: "seeded" },
        },
      },
    });
    const request = {
      id: "agent_step.docs-build.output",
      kind: "cognitive_work",
      work: {
        id: "agent_step.docs-build.output",
        source_type: "agent-step",
        envelope: {
          run_id: "rx_test",
          step_id: "docs-build",
          skill: "docs-build",
          instructions: "Build docs.",
          inputs: {},
          allowed_tools: [],
          current_context: [],
          historical_context: [],
          provenance: [],
          expected_outputs: {
            project_brief: "object",
          },
          trust_boundary: "local-test",
        },
      },
    } satisfies ResolutionRequest;

    await expect(caller.resolve(request)).resolves.toEqual({
      actor: "agent",
      payload: {
        project_brief: { summary: "seeded" },
      },
    });
    expect(loadManagedAgentConfig).not.toHaveBeenCalled();
    expect(executeManagedAgentResolution).not.toHaveBeenCalled();
  });

  it("falls back to the env-configured managed runtime for cognitive work", async () => {
    const caller = createRuntimeBackedCaller();
    const request = {
      id: "agent_step.docs-build.output",
      kind: "cognitive_work",
      work: {
        id: "agent_step.docs-build.output",
        source_type: "agent-step",
        envelope: {
          run_id: "rx_test",
          step_id: "docs-build",
          skill: "docs-build",
          instructions: "Build docs.",
          inputs: {},
          allowed_tools: [],
          current_context: [],
          historical_context: [],
          provenance: [],
          expected_outputs: {
            project_brief: "object",
          },
          trust_boundary: "local-test",
        },
      },
    } satisfies ResolutionRequest;

    await expect(caller.resolve(request)).resolves.toEqual({
      actor: "agent",
      payload: { echoed: "managed" },
    });
    expect(loadManagedAgentConfig).toHaveBeenCalledTimes(1);
    expect(executeManagedAgentResolution).toHaveBeenCalledTimes(1);
  });
});
