import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { runLocalSkill, type Caller } from "../packages/runner-local/src/index.js";
import type { SkillAdapter } from "../packages/executor/src/index.js";

const caller: Caller = {
  resolve: async () => undefined,
  report: () => undefined,
};

describe("merge-metadata", () => {
  it("preserves adapter runner provider metadata alongside runx trust metadata", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-merge-metadata-"));
    const adapter: SkillAdapter = {
      type: "agent",
      invoke: async () => ({
        status: "success",
        stdout: "ok",
        stderr: "",
        exitCode: 0,
        signal: null,
        durationMs: 1,
        metadata: {
          runner: {
            provider: "openai",
            model: "gpt-test",
            prompt_version: "prompt-v1",
          },
        },
      }),
    };

    try {
      const result = await runLocalSkill({
        skillPath: path.resolve("fixtures/skills/portable"),
        caller,
        adapters: [adapter],
        receiptDir: path.join(tempDir, "receipts"),
        runxHome: path.join(tempDir, "home"),
      });

      expect(result.status).toBe("success");
      if (result.status !== "success") {
        return;
      }
      expect(result.receipt.kind).toBe("skill_execution");
      if (result.receipt.kind !== "skill_execution") {
        return;
      }
      expect(result.receipt.metadata).toMatchObject({
        runner: {
          type: "agent",
          enforcement: "agent-mediated",
          attestation: "agent-reported",
          provider: "openai",
          model: "gpt-test",
          prompt_version: "prompt-v1",
        },
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("preserves hosted agent trust metadata when the adapter is runx-invoked", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-merge-hosted-agent-metadata-"));
    const adapter: SkillAdapter = {
      type: "agent",
      invoke: async () => ({
        status: "success",
        stdout: "ok",
        stderr: "",
        exitCode: 0,
        signal: null,
        durationMs: 1,
        metadata: {
          runner: {
            type: "agent",
            enforcement: "runx-invoked",
            attestation: "provider-reported",
            provider: "openai",
            model: "gpt-test",
            prompt_version: "prompt-v1",
          },
        },
      }),
    };

    try {
      const result = await runLocalSkill({
        skillPath: path.resolve("fixtures/skills/portable"),
        caller,
        adapters: [adapter],
        receiptDir: path.join(tempDir, "receipts"),
        runxHome: path.join(tempDir, "home"),
      });

      expect(result.status).toBe("success");
      if (result.status !== "success") {
        return;
      }
      expect(result.receipt.kind).toBe("skill_execution");
      if (result.receipt.kind !== "skill_execution") {
        return;
      }
      expect(result.receipt.metadata).toMatchObject({
        runner: {
          type: "agent",
          enforcement: "runx-invoked",
          attestation: "provider-reported",
          provider: "openai",
          model: "gpt-test",
          prompt_version: "prompt-v1",
        },
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
