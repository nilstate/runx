import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { createDefaultSkillAdapters } from "@runxhq/adapters";
import { createRunxSdk, createStructuredCaller } from "@runxhq/core/sdk";

describe("SDK imported tools", () => {
  it("discovers and executes imported fixture MCP tools", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-sdk-imported-tools-"));
    const skillDir = path.join(tempDir, "imported-tool-skill");
    const receiptDir = path.join(tempDir, "receipts");

    try {
      await mkdir(skillDir, { recursive: true });
      await writeFile(
        path.join(skillDir, "SKILL.md"),
        `---
name: imported-tool-skill
description: Uses an imported fixture tool.
source:
  type: chain
  chain:
    name: imported-tool-skill
    steps:
      - id: echo
        tool: fixture.echo
        inputs:
          message: from-sdk-imported-tool
---
Use the imported tool.
`,
      );

      const sdk = createRunxSdk({
        env: {
          ...process.env,
          RUNX_CWD: process.cwd(),
          RUNX_ENABLE_FIXTURE_TOOL_CATALOG: "1",
          RUNX_HOME: path.join(tempDir, "home"),
        },
        receiptDir,
        caller: createStructuredCaller(),
        adapters: createDefaultSkillAdapters(),
      });

      const searchResults = await sdk.searchTools({
        query: "echo",
        source: "fixture-mcp",
      });
      expect(searchResults).toEqual([
        expect.objectContaining({
          name: "fixture.echo",
          source: "fixture-mcp",
          source_type: "mcp",
        }),
      ]);

      const result = await sdk.runSkill({
        skillPath: skillDir,
      });
      expect(result.status).toBe("success");
      if (result.status !== "success") {
        return;
      }
      expect(result.execution.stdout).toContain("from-sdk-imported-tool");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 15_000);
});
