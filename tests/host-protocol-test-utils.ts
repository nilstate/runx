import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createDefaultSkillAdapters } from "@runxhq/adapters";
import { createRunxSdk, createHostBridge, type HostBridge } from "@runxhq/runtime-local/sdk";

export interface HostHarness {
  readonly bridge: HostBridge;
  readonly cleanup: () => Promise<void>;
}

export async function createHostHarness(): Promise<HostHarness> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-host-protocol-"));
  const sdk = createRunxSdk({
    env: { ...process.env, RUNX_CWD: process.cwd(), RUNX_HOME: path.join(tempDir, "home") },
    receiptDir: path.join(tempDir, "receipts"),
    adapters: createDefaultSkillAdapters(),
  });

  return {
    bridge: createHostBridge({ execute: sdk.runSkill.bind(sdk) }),
    cleanup: async () => {
      await rm(tempDir, { recursive: true, force: true });
    },
  };
}
