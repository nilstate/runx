import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { runCli } from "../packages/cli/src/index.js";

describe("CLI inspect/history receipt verification", () => {
  it("surfaces verified and invalid receipt status in JSON and human output", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-cli-verify-"));
    const receiptDir = path.join(tempDir, "receipts");
    const runxHome = path.join(tempDir, "home");

    try {
      const runStdout = createMemoryStream();
      const runExit = await runCli(
        ["skill", "fixtures/skills/echo", "--message", "hi", "--receipt-dir", receiptDir, "--json"],
        { stdin: process.stdin, stdout: runStdout, stderr: createMemoryStream() },
        { ...process.env, RUNX_CWD: process.cwd(), RUNX_HOME: runxHome },
      );
      expect(runExit).toBe(0);
      const runReport = JSON.parse(runStdout.contents()) as { receipt: { id: string } };

      const verifiedInspectStdout = createMemoryStream();
      const verifiedInspectExit = await runCli(
        ["skill", "inspect", runReport.receipt.id, "--receipt-dir", receiptDir, "--json"],
        { stdin: process.stdin, stdout: verifiedInspectStdout, stderr: createMemoryStream() },
        { ...process.env, RUNX_HOME: runxHome },
      );
      expect(verifiedInspectExit).toBe(0);
      expect(JSON.parse(verifiedInspectStdout.contents())).toMatchObject({
        verification: { status: "verified" },
        summary: {
          verification: { status: "verified" },
        },
      });

      const receiptPath = path.join(receiptDir, `${runReport.receipt.id}.json`);
      const contents = await readFile(receiptPath, "utf8");
      await writeFile(receiptPath, contents.replace('"status": "success"', '"status": "failure"'));

      const invalidHistoryStdout = createMemoryStream();
      const invalidHistoryExit = await runCli(
        ["history", "--receipt-dir", receiptDir, "--json"],
        { stdin: process.stdin, stdout: invalidHistoryStdout, stderr: createMemoryStream() },
        { ...process.env, RUNX_HOME: runxHome },
      );
      expect(invalidHistoryExit).toBe(0);
      expect(JSON.parse(invalidHistoryStdout.contents())).toMatchObject({
        status: "success",
        receipts: [
          {
            id: runReport.receipt.id,
            status: "failure",
            verification: { status: "invalid", reason: "signature_mismatch" },
          },
        ],
      });

      const humanHistoryStdout = createMemoryStream();
      const humanHistoryExit = await runCli(
        ["history", "echo", "--receipt-dir", receiptDir],
        { stdin: process.stdin, stdout: humanHistoryStdout, stderr: createMemoryStream() },
        { ...process.env, RUNX_HOME: runxHome },
      );
      expect(humanHistoryExit).toBe(0);
      expect(humanHistoryStdout.contents()).toContain(runReport.receipt.id.slice(0, 12));
      expect(humanHistoryStdout.contents()).toContain("history");
      expect(humanHistoryStdout.contents()).toContain("echo");
      expect(humanHistoryStdout.contents()).toContain("echo");
      expect(humanHistoryStdout.contents()).toContain("cli-tool");
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
