import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { createFileKnowledgeStore } from "@runxhq/core/knowledge";
import { runLocalGraph, runLocalSkill, type Caller, type ExecutionEvent } from "@runxhq/runtime-local";

const nonInteractiveCaller: Caller = {
  resolve: async () => undefined,
  report: () => undefined,
};

describe("local knowledge index integration", () => {
  it("indexes local skill receipts without changing the receipt file source of truth", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-local-knowledge-index-"));
    const receiptDir = path.join(tempDir, "receipts");
    const knowledgeDir = path.join(tempDir, "knowledge");
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
          RUNX_KNOWLEDGE_DIR: knowledgeDir,
          RUNX_PROJECT: project,
        },
      });

      expect(result.status).toBe("success");
      if (result.status !== "success") {
        return;
      }

      await expect(readdir(receiptDir)).resolves.toSatisfy((entries: string[]) => {
        return entries.includes("ledgers") && entries.filter((entry) => entry.endsWith(".json")).includes(`${result.receipt.id}.json`);
      });
      await expect(createFileKnowledgeStore(knowledgeDir).listReceipts({ project })).resolves.toEqual([
        expect.objectContaining({
          receipt_id: result.receipt.id,
          kind: "skill_execution",
          execution_ref: "echo",
          source_type: "cli-tool",
        }),
      ]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps a successful run alive when post-receipt knowledge indexing fails", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-local-knowledge-index-failure-"));
    const receiptDir = path.join(tempDir, "receipts");
    const badKnowledgePath = path.join(tempDir, "knowledge-file");
    const events: ExecutionEvent[] = [];

    const reportingCaller: Caller = {
      resolve: async () => undefined,
      report: (event) => {
        events.push(event);
      },
    };

    try {
      await writeFile(badKnowledgePath, "not-a-directory\n");

      const result = await runLocalSkill({
        skillPath: path.resolve("fixtures/skills/echo"),
        inputs: { message: "hi" },
        caller: reportingCaller,
        receiptDir,
        runxHome: path.join(tempDir, "home"),
        env: {
          ...process.env,
          RUNX_KNOWLEDGE_DIR: badKnowledgePath,
        },
      });

      expect(result.status).toBe("success");
      if (result.status !== "success") {
        return;
      }

      await expect(readdir(receiptDir)).resolves.toContain(`${result.receipt.id}.json`);
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "warning",
          message: "Local knowledge indexing failed after receipt write; continuing with the persisted receipt.",
          data: expect.objectContaining({
            receiptId: result.receipt.id,
          }),
        }),
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("indexes graph receipts when local knowledge indexing is enabled", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-local-knowledge-graph-index-"));
    const receiptDir = path.join(tempDir, "receipts");
    const knowledgeDir = path.join(tempDir, "knowledge");
    const project = path.join(tempDir, "project");

    try {
      const result = await runLocalGraph({
        graphPath: path.resolve("fixtures/graphs/sequential/graph.yaml"),
        caller: nonInteractiveCaller,
        receiptDir,
        runxHome: path.join(tempDir, "home"),
        env: {
          ...process.env,
          RUNX_KNOWLEDGE_DIR: knowledgeDir,
          RUNX_PROJECT: project,
          RUNX_CWD: tempDir,
          INIT_CWD: tempDir,
        },
      });

      expect(result.status).toBe("success");
      if (result.status !== "success") {
        return;
      }

      await expect(createFileKnowledgeStore(knowledgeDir).listReceipts({ project })).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            receipt_id: result.receipt.id,
            kind: "graph_execution",
            execution_ref: "sequential-echo",
          }),
        ]),
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
