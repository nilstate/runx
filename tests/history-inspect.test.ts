import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { runCli } from "../packages/cli/src/index.js";
import { createFileMemoryStore } from "../packages/memory/src/index.js";

describe("history, inspect, and memory CLI", () => {
  it("uses receipt files for history/inspect and memory index for project facts", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-history-inspect-"));
    const receiptDir = path.join(tempDir, "receipts");
    const memoryDir = path.join(tempDir, "memory");
    const project = path.join(tempDir, "project");

    try {
      const runStdout = createMemoryStream();
      const runStderr = createMemoryStream();
      const runExit = await runCli(
        [
          "skill",
          "fixtures/skills/echo",
          "--message",
          "hi",
          "--receipt-dir",
          receiptDir,
          "--json",
        ],
        { stdin: process.stdin, stdout: runStdout, stderr: runStderr },
        {
          ...process.env,
          RUNX_CWD: process.cwd(),
        },
      );
      expect(runExit).toBe(0);
      expect(runStderr.contents()).toBe("");
      const runReport = JSON.parse(runStdout.contents()) as { receipt: { id: string } };

      const historyStdout = createMemoryStream();
      const historyExit = await runCli(
        ["history", "echo", "--receipt-dir", receiptDir, "--json"],
        { stdin: process.stdin, stdout: historyStdout, stderr: createMemoryStream() },
        {
          ...process.env,
          RUNX_CWD: process.cwd(),
        },
      );
      expect(historyExit).toBe(0);
      expect(JSON.parse(historyStdout.contents())).toMatchObject({
        status: "success",
        query: "echo",
        receipts: [
          {
            id: runReport.receipt.id,
            kind: "skill_execution",
            name: "echo",
            sourceType: "cli-tool",
          },
        ],
      });

      const inspectStdout = createMemoryStream();
      const inspectExit = await runCli(
        ["skill", "inspect", runReport.receipt.id, "--receipt-dir", receiptDir, "--json"],
        { stdin: process.stdin, stdout: inspectStdout, stderr: createMemoryStream() },
        {
          ...process.env,
          RUNX_CWD: process.cwd(),
        },
      );
      expect(inspectExit).toBe(0);
      expect(JSON.parse(inspectStdout.contents())).toMatchObject({
        summary: {
          id: runReport.receipt.id,
          kind: "skill_execution",
          name: "echo",
        },
      });

      await createFileMemoryStore(memoryDir).addFact({
        project,
        scope: "project",
        key: "homepage_url",
        value: "https://example.test",
        source: "test",
        confidence: 0.95,
        freshness: "fresh",
        receiptId: runReport.receipt.id,
        createdAt: "2026-04-10T00:00:00Z",
      });

      const memoryStdout = createMemoryStream();
      const memoryExit = await runCli(
        ["memory", "show", "--project", project, "--json"],
        { stdin: process.stdin, stdout: memoryStdout, stderr: createMemoryStream() },
        {
          ...process.env,
          RUNX_MEMORY_DIR: memoryDir,
          RUNX_CWD: process.cwd(),
        },
      );
      expect(memoryExit).toBe(0);
      expect(JSON.parse(memoryStdout.contents())).toMatchObject({
        status: "success",
        project,
        facts: [
          {
            key: "homepage_url",
            value: "https://example.test",
            receipt_id: runReport.receipt.id,
          },
        ],
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

function createMemoryStream(): NodeJS.WriteStream & { contents: () => string } {
  let contents = "";
  return {
    write(chunk: unknown) {
      contents += String(chunk);
      return true;
    },
    contents: () => contents,
  } as NodeJS.WriteStream & { contents: () => string };
}
