import { describe, expect, it } from "vitest";

import { validateAgentContextEnvelope } from "./index.js";

describe("agent context envelope", () => {
  it("rejects legacy context.voice_grammar aliases", () => {
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
          content: "legacy",
        },
      },
      trust_boundary: "test",
    })).toThrow("context.voice_grammar is no longer supported; use voice_profile");
  });
});
