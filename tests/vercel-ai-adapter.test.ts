import { afterEach, describe, expect, it } from "vitest";

import { createVercelAiAdapter } from "../packages/sdk-js/src/index.js";
import { createFrameworkHarness } from "./framework-adapter-test-utils.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    if (cleanup) {
      await cleanup();
    }
  }
});

describe("Vercel AI SDK adapter", () => {
  it("wraps paused and resumed runs in a Vercel AI-style response", async () => {
    const harness = await createFrameworkHarness();
    cleanups.push(harness.cleanup);
    const adapter = createVercelAiAdapter(harness.bridge);

    const paused = await adapter.run({
      skillPath: "fixtures/skills/echo",
    });

    expect(paused.data.runx.status).toBe("paused");
    if (paused.data.runx.status !== "paused") {
      return;
    }

    const resumed = await adapter.resume(paused.data.runx.runId, {
      skillPath: "fixtures/skills/echo",
      resolver: ({ request }) => (request.kind === "input" ? { message: "from-vercel-ai-adapter" } : undefined),
    });

    expect(resumed.data.runx).toMatchObject({
      status: "completed",
      output: "from-vercel-ai-adapter",
    });
  });
});
