import { describe, expect, it } from "vitest";

import { validateAgentContextEnvelope } from "./index.js";

describe("agent context envelope", () => {
  it("rejects removed context.voice_grammar fields", () => {
    expect(() => validateAgentContextEnvelope({
      run_id: "rx_test",
      skill: "demo",
      instructions: "Do the work.",
      inputs: {},
      allowed_tools: [],
      current_context: [],
      historical_context: [],
      provenance: [],
      context: {
        voice_grammar: {
          root_path: "/tmp",
          path: "/tmp/VOICE.md",
          sha256: "abc123",
          content: "removed",
        },
      },
      trust_boundary: "test",
    })).toThrow("agent_context_envelope.context.voice_grammar must match");
  });

  it("accepts execution_location metadata for surfaced cognitive work", () => {
    expect(validateAgentContextEnvelope({
      run_id: "rx_test",
      step_id: "plan",
      skill: "demo.plan",
      instructions: "Do the work.",
      inputs: {},
      allowed_tools: ["fs.read"],
      current_context: [],
      historical_context: [],
      provenance: [],
      execution_location: {
        skill_directory: "/tmp/demo-skill",
        tool_roots: ["/tmp/extra-tools"],
      },
      trust_boundary: "test",
    })).toMatchObject({
      execution_location: {
        skill_directory: "/tmp/demo-skill",
        tool_roots: ["/tmp/extra-tools"],
      },
    });
  });
});
