import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createOpenAiSurfaceAdapter, createRunxSdk, createSurfaceBridge } from "@runxhq/core/sdk";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    if (cleanup) {
      await cleanup();
    }
  }
});

describe("surface protocol", () => {
  it("exposes the canonical surface bridge and provider wrapper", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-surface-protocol-"));
    cleanups.push(async () => {
      await rm(tempDir, { recursive: true, force: true });
    });

    const sdk = createRunxSdk({
      env: { ...process.env, RUNX_CWD: process.cwd(), RUNX_HOME: path.join(tempDir, "home") },
      receiptDir: path.join(tempDir, "receipts"),
    });

    const bridge = createSurfaceBridge({ execute: sdk.runSkill.bind(sdk) });
    const adapter = createOpenAiSurfaceAdapter(bridge);

    const paused = await adapter.run({
      skillPath: "fixtures/skills/echo",
    });

    expect(paused.role).toBe("tool");
    expect(paused.structuredContent.runx.status).toBe("paused");
  });
});
