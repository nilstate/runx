import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { createFileMemoryStore } from "../packages/memory/src/index.js";
import { runLocalSkill, type Caller } from "../packages/runner-local/src/index.js";

const nonInteractiveCaller: Caller = {
  resolve: async () => undefined,
  report: () => undefined,
};

describe("local memory index integration", () => {
  it("indexes local skill receipts without changing the receipt file source of truth", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-local-memory-index-"));
    const receiptDir = path.join(tempDir, "receipts");
    const memoryDir = path.join(tempDir, "memory");
    const project = path.join(tempDir, "project");

    try {
      const result = await runLocalSkill({
        skillPath: path.resolve("fixtures/skills/echo"),
        inputs: { message: "hi" },
        caller: nonInteractiveCaller,
        receiptDir,
        runxHome: path.join(tempDir, "home"),
        env: {
          ...process.env,
          RUNX_MEMORY_DIR: memoryDir,
          RUNX_PROJECT: project,
        },
      });

      expect(result.status).toBe("success");
      if (result.status !== "success") {
        return;
      }

      await expect(readdir(receiptDir)).resolves.toSatisfy((entries: string[]) => {
        return entries.includes("journals") && entries.filter((entry) => entry.endsWith(".json")).includes(`${result.receipt.id}.json`);
      });
      await expect(createFileMemoryStore(memoryDir).listReceipts({ project })).resolves.toEqual([
        expect.objectContaining({
          receipt_id: result.receipt.id,
          kind: "skill_execution",
          subject: "echo",
          source_type: "cli-tool",
        }),
      ]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
