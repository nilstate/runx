import { describe, expect, it } from "vitest";

import { parseSkillMarkdown, validateSkill } from "../parser/index.js";
import { createHarnessHookAdapter } from "./agent-hook.js";

describe("harness-hook adapter", () => {
  it("invokes a deterministic hook through the adapter seam", async () => {
    const skill = validateSkill(
      parseSkillMarkdown(`---
name: review-receipt
source:
  type: harness-hook
  hook: review-receipt
  outputs:
    verdict: string
inputs:
  receipt_id:
    type: string
    required: true
---
Review a receipt.
`),
    );
    const adapter = createHarnessHookAdapter({
      handlers: {
        "review-receipt": () => ({ output: { verdict: "pass" } }),
      },
    });

    const result = await adapter.invoke({
      source: skill.source,
      inputs: { receipt_id: "rx_123" },
      skillDirectory: process.cwd(),
      env: process.env,
    });

    expect(result.status).toBe("success");
    expect(JSON.parse(result.stdout)).toEqual({ verdict: "pass" });
    expect(result.metadata).toMatchObject({
      agent_hook: {
        source_type: "harness-hook",
        hook: "review-receipt",
        status: "success",
      },
    });
  });

  it("returns sanitized failure metadata", async () => {
    const skill = validateSkill(
      parseSkillMarkdown(`---
name: failing-hook
source:
  type: harness-hook
  hook: fail
---
Fail.
`),
    );
    const adapter = createHarnessHookAdapter({
      handlers: {
        fail: () => ({ status: "failure", errorMessage: "fixture failure" }),
      },
    });

    const result = await adapter.invoke({
      source: skill.source,
      inputs: {},
      skillDirectory: process.cwd(),
      env: process.env,
    });

    expect(result.status).toBe("failure");
    expect(result.stderr).toBe("fixture failure");
    expect(result.metadata).toMatchObject({
      agent_hook: {
        hook: "fail",
        status: "failure",
      },
    });
  });
});
