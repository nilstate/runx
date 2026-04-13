import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { runLocalSkill, type Caller } from "../packages/runner-local/src/index.js";

const nonInteractiveCaller: Caller = {
  resolve: async () => undefined,
  report: () => undefined,
};

describe("MCP skill runner", () => {
  it("runs an MCP fixture skill and writes sanitized receipt metadata", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-mcp-skill-"));
    const receiptDir = path.join(tempDir, "receipts");
    const runxHome = path.join(tempDir, "home");

    try {
      const result = await runLocalSkill({
        skillPath: path.resolve("fixtures/skills/mcp-echo"),
        inputs: { message: "super-secret-value" },
        caller: nonInteractiveCaller,
        receiptDir,
        runxHome,
        env: process.env,
      });

      expect(result.status).toBe("success");
      if (result.status !== "success") {
        return;
      }

      expect(result.execution.stdout).toBe("super-secret-value");
      expect(result.receipt.kind).toBe("skill_execution");
      if (result.receipt.kind !== "skill_execution") {
        return;
      }
      expect(result.receipt.metadata).toMatchObject({
        mcp: {
          tool: "echo",
        },
      });

      const receiptContents = await readFile(path.join(receiptDir, `${result.receipt.id}.json`), "utf8");
      expect(receiptContents).toContain('"tool": "echo"');
      expect(receiptContents).toContain("server_command_hash");
      expect(receiptContents).not.toContain("super-secret-value");
      expect(receiptContents).not.toContain("packages/harness/src/mcp-fixture.ts");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 15000);
});
