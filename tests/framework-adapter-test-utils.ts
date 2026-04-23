import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createFrameworkBridge, createRunxSdk, type FrameworkBridge } from "@runxhq/core/sdk";

export interface FrameworkHarness {
  readonly bridge: FrameworkBridge;
  readonly cleanup: () => Promise<void>;
}

export async function createFrameworkHarness(): Promise<FrameworkHarness> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-framework-adapters-"));
  const sdk = createRunxSdk({
    env: { ...process.env, RUNX_CWD: process.cwd(), RUNX_HOME: path.join(tempDir, "home") },
    receiptDir: path.join(tempDir, "receipts"),
  });

  return {
    bridge: createFrameworkBridge({ execute: sdk.runSkill.bind(sdk) }),
    cleanup: async () => {
      await rm(tempDir, { recursive: true, force: true });
    },
  };
}
