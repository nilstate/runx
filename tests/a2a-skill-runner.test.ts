import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { runCli } from "../packages/cli/src/index.js";

describe("A2A skill runner", () => {
  it("runs a standard skill through a materialized A2A binding and writes sanitized receipt metadata", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-a2a-skill-"));
    const receiptDir = path.join(tempDir, "receipts");
    const stdout = createMemoryStream();
    const stderr = createMemoryStream();

    try {
      const exitCode = await runCli(
        [
          "skill",
          "fixtures/skills/a2a-echo/SKILL.md",
          "--runner",
          "fixture-a2a",
          "--message",
          "hi",
          "--receipt-dir",
          receiptDir,
          "--json",
        ],
        { stdin: process.stdin, stdout, stderr },
        {
          ...process.env,
          RUNX_CWD: process.cwd(),
        },
      );

      expect(exitCode).toBe(0);
      expect(stderr.contents()).toBe("");
      const result = JSON.parse(stdout.contents()) as {
        execution: { stdout: string };
        receipt: {
          id: string;
          subject: { source_type: string };
          metadata?: Record<string, unknown>;
        };
      };

      expect(result.execution.stdout).toBe("hi");
      expect(result.receipt.subject.source_type).toBe("a2a");
      expect(result.receipt.metadata).toMatchObject({
        a2a: {
          agent_card_url_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
          agent_identity: "echo-agent",
          task: "echo",
          task_status: "completed",
          message_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
          output_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
        runner: {
          type: "a2a",
          enforcement: "runx-enforced",
          attestation: "runx-observed",
        },
      });

      const receiptContents = await readFile(path.join(receiptDir, `${result.receipt.id}.json`), "utf8");
      expect(receiptContents).not.toContain("fixture://echo-agent");
      expect(receiptContents).not.toContain('"message":"hi"');
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
