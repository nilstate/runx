import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { createA2aAdapter } from "../packages/adapters/src/a2a/index.js";
import { createDefaultSkillAdapters } from "../packages/adapters/src/index.js";
import { createA2aFixtureTransport } from "@runxhq/runtime-local/harness";
import { runLocalSkill, type Caller } from "@runxhq/runtime-local";

const nonInteractiveCaller: Caller = {
  resolve: async () => undefined,
  report: async () => undefined,
};

describe("A2A skill runner", () => {
  it("runs a standard skill through a materialized A2A binding and writes sanitized receipt metadata", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-a2a-skill-"));
    const receiptDir = path.join(tempDir, "receipts");

    try {
      const result = await runLocalSkill({
        skillPath: path.resolve("fixtures/skills/a2a-echo"),
        runner: "fixture-a2a",
        inputs: { message: "hi" },
        caller: nonInteractiveCaller,
        receiptDir,
        runxHome: path.join(tempDir, "home"),
        env: {
          ...process.env,
          RUNX_CWD: process.cwd(),
        },
        adapters: [
          ...createDefaultSkillAdapters(),
          createA2aAdapter({ transport: createA2aFixtureTransport() }),
        ],
      });

      expect(result.status).toBe("success");
      if (result.status !== "success") {
        return;
      }
      expect(result.execution.stdout).toBe("hi");
      expect(result.receipt.kind).toBe("skill_execution");
      if (result.receipt.kind !== "skill_execution") {
        return;
      }
      expect(result.receipt.source_type).toBe("a2a");
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
