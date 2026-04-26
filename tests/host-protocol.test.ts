import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createRunxSdk, createHostBridge } from "@runxhq/core/sdk";
import { createOpenAiHostAdapter } from "@runxhq/host-adapters";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    if (cleanup) {
      await cleanup();
    }
  }
});

describe("host protocol", () => {
  it("exposes the canonical host bridge and provider wrapper", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-host-protocol-"));
    cleanups.push(async () => {
      await rm(tempDir, { recursive: true, force: true });
    });

    const sdk = createRunxSdk({
      env: { ...process.env, RUNX_CWD: process.cwd(), RUNX_HOME: path.join(tempDir, "home") },
      receiptDir: path.join(tempDir, "receipts"),
    });

    const bridge = createHostBridge({ execute: sdk.runSkill.bind(sdk) });
    const adapter = createOpenAiHostAdapter(bridge);

    const paused = await adapter.run({
      skillPath: "fixtures/skills/echo",
    });

    expect(paused.role).toBe("tool");
    expect(paused.structuredContent.runx.status).toBe("paused");
  });

  it("maps escalated graph receipts to an explicit host status", async () => {
    const bridge = createHostBridge({
      execute: async () => ({
        status: "failure",
        skill: { name: "fanout-skill" },
        inputs: {},
        execution: {
          status: "failure",
          stdout: "",
          stderr: "",
          exitCode: 1,
          signal: null,
          durationMs: 1,
          errorMessage: "fanout escalation: conflicting recommendations",
        },
        state: {},
        receipt: {
          id: "gx_escalated",
          kind: "graph_execution",
          status: "failure",
          duration_ms: 1,
          disposition: "escalated",
          outcome_state: "pending",
        },
      }) as any,
    });

    const result = await bridge.run({ skillPath: "unused" });

    expect(result).toMatchObject({
      status: "escalated",
      skillName: "fanout-skill",
      receiptId: "gx_escalated",
      error: "fanout escalation: conflicting recommendations",
    });
  });
});
