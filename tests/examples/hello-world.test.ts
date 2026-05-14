import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { runLocalSkill, type Caller } from "@runxhq/runtime-local";
import { createDefaultLocalSkillRuntime } from "../../packages/adapters/src/runtime.js";

const nonInteractiveCaller: Caller = {
  resolve: async () => undefined,
  report: () => undefined,
};

describe("hello-world example", () => {
  it("runs as a local cli-tool skill and writes a receipt", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-hello-world-example-"));

    try {
      const runtime = await createDefaultLocalSkillRuntime({
        root: tempDir,
        receiptDir: path.join(tempDir, "receipts"),
        runxHome: path.join(tempDir, "home"),
        env: process.env,
      });

      const result = await runLocalSkill({
        skillPath: path.resolve("examples/hello-world"),
        inputs: { message: "hello from docs" },
        caller: nonInteractiveCaller,
        adapters: runtime.adapters,
        receiptDir: runtime.paths.receiptDir,
        runxHome: runtime.paths.runxHome,
        env: runtime.env,
      });

      expect(result.status).toBe("success");
      if (result.status !== "success") {
        return;
      }
      expect(result.execution.stdout).toBe("hello from docs\n");
      expect(result.receipt.kind).toBe("skill_execution");
      if (result.receipt.kind !== "skill_execution") {
        return;
      }
      expect(result.receipt.skill_name).toBe("hello-world");
      expect(result.receipt.source_type).toBe("cli-tool");
      expect(result.receipt.status).toBe("success");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
