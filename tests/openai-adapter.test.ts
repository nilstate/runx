import { afterEach, describe, expect, it } from "vitest";

import { createOpenAiHostAdapter } from "@runxhq/host-adapters";
import { createHostHarness } from "./host-protocol-test-utils.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    if (cleanup) {
      await cleanup();
    }
  }
});

describe("OpenAI host adapter", () => {
  it("wraps paused and resumed runs in an OpenAI-style tool response", async () => {
    const harness = await createHostHarness();
    cleanups.push(harness.cleanup);
    const adapter = createOpenAiHostAdapter(harness.bridge);

    const paused = await adapter.run({
      skillPath: "fixtures/skills/echo",
    });

    expect(paused.role).toBe("tool");
    expect(paused.structuredContent.runx.status).toBe("paused");
    if (paused.structuredContent.runx.status !== "paused") {
      return;
    }

    const resumed = await adapter.resume(paused.structuredContent.runx.runId, {
      skillPath: "fixtures/skills/echo",
      resolver: ({ request }) => (request.kind === "input" ? { message: "from-openai-host-adapter" } : undefined),
    });

    expect(resumed.role).toBe("tool");
    expect(resumed.structuredContent.runx).toMatchObject({
      status: "completed",
      output: "from-openai-host-adapter",
    });
  });
});
