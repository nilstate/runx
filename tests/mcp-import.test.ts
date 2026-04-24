import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { createDefaultSkillAdapters } from "@runxhq/adapters";
import { parseGraphYaml, validateGraph } from "@runxhq/core/parser";
import { runLocalGraph, type Caller } from "@runxhq/core/runner-local";
import { createFixtureMcpToolCatalogAdapter } from "@runxhq/core/tool-catalogs";

const noOpCaller: Caller = {
  resolve: async () => undefined,
  report: () => undefined,
};

describe("MCP tool catalog import", () => {
  it("runs imported MCP tools through the normal graph runtime", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-mcp-import-"));
    const receiptDir = path.join(tempDir, "receipts");
    const runxHome = path.join(tempDir, "home");

    const graph = validateGraph(
      parseGraphYaml(`
name: imported-tool
steps:
  - id: echo
    tool: fixture.echo
    inputs:
      message: hello from imported tool
`),
    );

    try {
      const result = await runLocalGraph({
        graph,
        graphDirectory: tempDir,
        caller: noOpCaller,
        env: { ...process.env, RUNX_CWD: process.cwd() },
        receiptDir,
        runxHome,
        adapters: createDefaultSkillAdapters(),
        toolCatalogAdapters: [createFixtureMcpToolCatalogAdapter()],
      });

      expect(result.status).toBe("success");
      if (result.status !== "success") {
        return;
      }

      expect(result.steps).toEqual([
        expect.objectContaining({
          skill: "fixture.echo",
          runner: "tool",
          status: "success",
          stdout: "hello from imported tool",
        }),
      ]);
      expect(result.receipt.kind).toBe("graph_execution");
      expect(result.output).toContain("hello from imported tool");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
