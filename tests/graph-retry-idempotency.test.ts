import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { SkillAdapter } from "@runxhq/core/executor";
import { runLocalGraph, type Caller } from "@runxhq/runtime-local";

const nonInteractiveCaller: Caller = {
  resolve: async () => undefined,
  report: () => undefined,
};

describe("graph retry and idempotency", () => {
  it("retries a read-only step and records attempt receipts", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-retry-read-"));
    const adapter = createFlakyAdapter();

    try {
      const result = await runLocalGraph({
        graphPath: path.resolve("fixtures/graphs/retry/read-only.yaml"),
        caller: nonInteractiveCaller,
        receiptDir: path.join(tempDir, "receipts"),
        runxHome: path.join(tempDir, "home"),
        env: process.env,
        adapters: [adapter],
      });

      expect(result.status).toBe("success");
      if (result.status !== "success") {
        return;
      }
      expect(result.steps.map((step) => [step.stepId, step.attempt, step.status])).toEqual([
        ["flaky-read", 1, "failure"],
        ["flaky-read", 2, "success"],
      ]);
      expect(result.receipt.steps.map((step) => step.retry)).toEqual([
        {
          attempt: 1,
          max_attempts: 2,
          rule_fired: "initial_attempt",
        },
        {
          attempt: 2,
          max_attempts: 2,
          rule_fired: "retry_attempt",
        },
      ]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("denies mutating retry without idempotency before execution", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-retry-denied-"));
    const adapter = createFlakyAdapter();

    try {
      const result = await runLocalGraph({
        graphPath: path.resolve("fixtures/graphs/retry/mutating-denied.yaml"),
        caller: nonInteractiveCaller,
        receiptDir: path.join(tempDir, "receipts"),
        runxHome: path.join(tempDir, "home"),
        env: process.env,
        adapters: [adapter],
      });

      expect(result.status).toBe("policy_denied");
      if (result.status !== "policy_denied") {
        return;
      }
      expect(result.reasons).toEqual(["step 'deploy' declares mutating retry without an idempotency key"]);
      expect(adapter.callCount()).toBe(0);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("honors skill-level retry metadata when the graph step omits retry", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-retry-skill-"));
    const adapter = createFlakyAdapter();

    try {
      const result = await runLocalGraph({
        graphPath: path.resolve("fixtures/graphs/retry/skill-level.yaml"),
        caller: nonInteractiveCaller,
        receiptDir: path.join(tempDir, "receipts"),
        runxHome: path.join(tempDir, "home"),
        env: process.env,
        adapters: [adapter],
      });

      expect(result.status).toBe("success");
      if (result.status !== "success") {
        return;
      }
      expect(result.steps.map((step) => [step.stepId, step.attempt, step.status])).toEqual([
        ["skill-retry", 1, "failure"],
        ["skill-retry", 2, "success"],
      ]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("denies skill-level mutating retry without requiring duplicate graph-step metadata", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-retry-skill-denied-"));
    const adapter = createFlakyAdapter();

    try {
      const result = await runLocalGraph({
        graphPath: path.resolve("fixtures/graphs/retry/skill-mutating-denied.yaml"),
        caller: nonInteractiveCaller,
        receiptDir: path.join(tempDir, "receipts"),
        runxHome: path.join(tempDir, "home"),
        env: process.env,
        adapters: [adapter],
      });

      expect(result.status).toBe("policy_denied");
      if (result.status !== "policy_denied") {
        return;
      }
      expect(result.reasons).toEqual(["step 'deploy' declares mutating retry without an idempotency key"]);
      expect(adapter.callCount()).toBe(0);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("retries a mutating step with idempotency key hash and no raw key in receipts", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-retry-idem-"));
    const receiptDir = path.join(tempDir, "receipts");
    const adapter = createFlakyAdapter();

    try {
      const result = await runLocalGraph({
        graphPath: path.resolve("fixtures/graphs/retry/mutating-idempotent.yaml"),
        caller: nonInteractiveCaller,
        receiptDir,
        runxHome: path.join(tempDir, "home"),
        env: process.env,
        adapters: [adapter],
      });

      expect(result.status).toBe("success");
      if (result.status !== "success") {
        return;
      }
      expect(result.steps).toHaveLength(2);
      const hashes = result.receipt.steps.map((step) => step.retry?.idempotency_key_hash);
      expect(hashes[0]).toBeTruthy();
      expect(hashes[0]).toBe(hashes[1]);

      const graphReceipt = await readFile(path.join(receiptDir, `${result.receipt.id}.json`), "utf8");
      const firstAttemptReceipt = await readFile(path.join(receiptDir, `${result.steps[0].receiptId}.json`), "utf8");
      expect(graphReceipt).not.toContain("deploy-123");
      expect(firstAttemptReceipt).not.toContain("deploy-123");
      expect(firstAttemptReceipt).toContain("idempotency_key_hash");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

function createFlakyAdapter(): SkillAdapter & { callCount: () => number } {
  let calls = 0;
  return {
    type: "cli-tool",
    callCount: () => calls,
    invoke: async (request) => {
      calls += 1;
      if (calls === 1) {
        return {
          status: "failure",
          stdout: "",
          stderr: "transient failure",
          exitCode: 1,
          signal: null,
          durationMs: 1,
          errorMessage: "transient failure",
        };
      }
      return {
        status: "success",
        stdout: String(request.inputs.message ?? "ok"),
        stderr: "",
        exitCode: 0,
        signal: null,
        durationMs: 1,
      };
    },
  };
}
