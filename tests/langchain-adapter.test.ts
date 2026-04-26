import { afterEach, describe, expect, it } from "vitest";

import { createLangChainHostAdapter } from "@runxhq/host-adapters";
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

describe("LangChain host adapter", () => {
  it("wraps paused and resumed runs in a LangChain-style response", async () => {
    const harness = await createHostHarness();
    cleanups.push(harness.cleanup);
    const adapter = createLangChainHostAdapter(harness.bridge);

    const paused = await adapter.run({
      skillPath: "fixtures/skills/echo",
    });

    expect(paused.additional_kwargs.runx.status).toBe("paused");
    if (paused.additional_kwargs.runx.status !== "paused") {
      return;
    }

    const resumed = await adapter.resume(paused.additional_kwargs.runx.runId, {
      skillPath: "fixtures/skills/echo",
      resolver: ({ request }) => (request.kind === "input" ? { message: "from-langchain-host-adapter" } : undefined),
    });

    expect(resumed.additional_kwargs.runx).toMatchObject({
      status: "completed",
      output: "from-langchain-host-adapter",
    });
  });
});
