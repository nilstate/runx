import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { runLocalSkill, type Caller } from "@runxhq/core/runner-local";

const nonInteractiveCaller: Caller = {
  resolve: async () => undefined,
  report: () => undefined,
};

describe("local skill runner", () => {
  it("runs a local cli-tool skill and writes a hashed receipt", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-local-skill-"));
    const receiptDir = path.join(tempDir, "receipts");
    const runxHome = path.join(tempDir, "home");

    try {
      const result = await runLocalSkill({
        skillPath: path.resolve("fixtures/skills/echo"),
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
      expect(result.receipt.status).toBe("success");

      const files = await readdir(receiptDir);
      expect(files).toContain("ledgers");
      expect(files.filter((file) => file.endsWith(".json"))).toEqual([`${result.receipt.id}.json`]);

      const receiptContents = await readFile(path.join(receiptDir, `${result.receipt.id}.json`), "utf8");
      expect(receiptContents).not.toContain('"message":"super-secret-value"');
      expect(receiptContents).not.toContain("super-secret-value");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("runs a portable skill through the agent-mediated runner", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-standard-skill-"));
    const caller: Caller = {
      resolve: async (request) =>
        request.kind === "cognitive_work" && request.id === "agent.portable.output"
          ? {
              actor: "agent",
              payload: {
                status: "done",
                summary: "caller executed the portable skill",
              },
            }
          : undefined,
      report: () => undefined,
    };

    try {
      const result = await runLocalSkill({
        skillPath: path.resolve("fixtures/skills/portable"),
        inputs: { message: "hi" },
        caller,
        receiptDir: path.join(tempDir, "receipts"),
        runxHome: path.join(tempDir, "home"),
        env: process.env,
      });

      expect(result.status).toBe("success");
      if (result.status !== "success") {
        return;
      }
      expect(JSON.parse(result.execution.stdout)).toEqual({
        status: "done",
        summary: "caller executed the portable skill",
      });
      expect(result.receipt.kind).toBe("skill_execution");
      if (result.receipt.kind !== "skill_execution") {
        return;
      }
      expect(result.receipt.source_type).toBe("agent");
      expect(result.receipt.metadata).toMatchObject({
        agent_runner: {
          skill: "portable",
          status: "success",
        },
        runner: {
          type: "agent",
          enforcement: "agent-mediated",
          attestation: "agent-reported",
        },
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("receipts deterministic runners as runx-enforced", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-deterministic-skill-"));

    try {
      const result = await runLocalSkill({
        skillPath: path.resolve("fixtures/skills/echo"),
        inputs: { message: "hi" },
        caller: nonInteractiveCaller,
        receiptDir: path.join(tempDir, "receipts"),
        runxHome: path.join(tempDir, "home"),
        env: process.env,
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
          type: "cli-tool",
          enforcement: "runx-enforced",
          attestation: "runx-observed",
        },
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("returns a resolution request when required inputs are unresolved", async () => {
    const result = await runLocalSkill({
      skillPath: path.resolve("fixtures/skills/echo"),
      caller: nonInteractiveCaller,
      env: process.env,
    });

    expect(result.status).toBe("needs_resolution");
    if (result.status !== "needs_resolution") {
      return;
    }
    expect(result.requests).toMatchObject([
      {
        kind: "input",
        questions: [expect.objectContaining({ id: "message" })],
      },
    ]);
  });

  it("records caller-supplied execution semantics in the receipt", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-runtime-semantics-"));

    try {
      const result = await runLocalSkill({
        skillPath: path.resolve("fixtures/skills/echo"),
        inputs: { message: "capture this" },
        caller: nonInteractiveCaller,
        receiptDir: path.join(tempDir, "receipts"),
        runxHome: path.join(tempDir, "home"),
        env: process.env,
        executionSemantics: {
          disposition: "observing",
          outcome_state: "pending",
          outcome: {
            code: "awaiting_observation",
            summary: "Execution succeeded but the durable outcome is pending.",
          },
          input_context: {
            capture: true,
            max_bytes: 256,
          },
          surface_refs: [{ type: "issue", uri: "github://owner/repo/issues/1" }],
          evidence_refs: [{ type: "log", uri: "file://receipt-log" }],
        },
      });

      expect(result.status).toBe("success");
      if (result.status !== "success" || result.receipt.kind !== "skill_execution") {
        return;
      }

      expect(result.receipt).toMatchObject({
        disposition: "observing",
        outcome_state: "pending",
        outcome: {
          code: "awaiting_observation",
        },
        surface_refs: [{ type: "issue", uri: "github://owner/repo/issues/1" }],
        evidence_refs: [{ type: "log", uri: "file://receipt-log" }],
      });
      expect(result.receipt.input_context).toMatchObject({
        source: "inputs",
        truncated: false,
      });
      expect(result.receipt.input_context?.snapshot).toEqual({ message: "[redacted]" });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
