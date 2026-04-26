import { afterEach, describe, expect, it } from "vitest";

import { createAnthropicHostAdapter } from "@runxhq/host-adapters";
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

describe("Anthropic host adapter", () => {
  it("wraps paused and resumed runs in an Anthropic-style response", async () => {
    const harness = await createHostHarness();
    cleanups.push(harness.cleanup);
    const adapter = createAnthropicHostAdapter(harness.bridge);

    const paused = await adapter.run({
      skillPath: "fixtures/skills/echo",
    });

    expect(paused.metadata.runx.status).toBe("paused");
    if (paused.metadata.runx.status !== "paused") {
      return;
    }

    const resumed = await adapter.resume(paused.metadata.runx.runId, {
      skillPath: "fixtures/skills/echo",
      resolver: ({ request }) => (request.kind === "input" ? { message: "from-anthropic-host-adapter" } : undefined),
    });

    expect(resumed.metadata.runx).toMatchObject({
      status: "completed",
      output: "from-anthropic-host-adapter",
    });
  });
});
