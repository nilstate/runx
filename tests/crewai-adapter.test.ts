import { afterEach, describe, expect, it } from "vitest";

import { createCrewAiHostAdapter } from "@runxhq/host-adapters";
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

describe("CrewAI host adapter", () => {
  it("wraps paused and resumed runs in a CrewAI-style response", async () => {
    const harness = await createHostHarness();
    cleanups.push(harness.cleanup);
    const adapter = createCrewAiHostAdapter(harness.bridge);

    const paused = await adapter.run({
      skillPath: "fixtures/skills/echo",
    });

    expect(paused.json_dict.runx.status).toBe("paused");
    if (paused.json_dict.runx.status !== "paused") {
      return;
    }

    const resumed = await adapter.resume(paused.json_dict.runx.runId, {
      skillPath: "fixtures/skills/echo",
      resolver: ({ request }) => (request.kind === "input" ? { message: "from-crewai-host-adapter" } : undefined),
    });

    expect(resumed.json_dict.runx).toMatchObject({
      status: "completed",
      output: "from-crewai-host-adapter",
    });
  });
});
