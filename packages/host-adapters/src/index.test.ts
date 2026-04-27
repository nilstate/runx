import { describe, expect, it } from "vitest";

import type { HostBridge, HostRunResult, HostRunState } from "@runxhq/runtime-local/sdk";
import {
  createAnthropicHostAdapter,
  createCrewAiHostAdapter,
  createLangChainHostAdapter,
  createOpenAiHostAdapter,
  createVercelAiHostAdapter,
} from "./index.js";

function fakeBridge(result: HostRunResult): HostBridge {
  return {
    run: async () => result,
    resume: async () => result,
    inspect: async () => result as HostRunState,
  };
}

describe("host host adapters", () => {
  const paused: HostRunResult = {
    status: "paused",
    skillName: "echo",
    runId: "rx_paused",
    requests: [],
    events: [],
  };

  it("wraps OpenAI tool responses", async () => {
    const response = await createOpenAiHostAdapter(fakeBridge(paused)).run({ skillPath: "unused" });
    expect(response).toMatchObject({
      role: "tool",
      structuredContent: {
        runx: {
          status: "paused",
          runId: "rx_paused",
        },
      },
    });
  });

  it("wraps Anthropic responses", async () => {
    const response = await createAnthropicHostAdapter(fakeBridge(paused)).run({ skillPath: "unused" });
    expect(response.metadata.runx.status).toBe("paused");
  });

  it("wraps Vercel AI SDK responses", async () => {
    const response = await createVercelAiHostAdapter(fakeBridge(paused)).run({ skillPath: "unused" });
    expect(response.data.runx.status).toBe("paused");
  });

  it("wraps LangChain responses", async () => {
    const response = await createLangChainHostAdapter(fakeBridge(paused)).run({ skillPath: "unused" });
    expect(response.additional_kwargs.runx.status).toBe("paused");
  });

  it("wraps CrewAI responses", async () => {
    const response = await createCrewAiHostAdapter(fakeBridge(paused)).run({ skillPath: "unused" });
    expect(response.json_dict.runx.status).toBe("paused");
  });
});
