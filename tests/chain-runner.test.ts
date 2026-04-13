import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { runCli } from "../packages/cli/src/index.js";
import { inspectLocalChain, runLocalChain, type Caller } from "../packages/runner-local/src/index.js";

const nonInteractiveCaller: Caller = {
  resolve: async () => undefined,
  report: () => undefined,
};

describe("local chain runner", () => {
  it("runs a sequential chain and writes linked receipts", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-chain-"));
    const receiptDir = path.join(tempDir, "receipts");
    const runxHome = path.join(tempDir, "home");

    try {
      const result = await runLocalChain({
        chainPath: path.resolve("fixtures/chains/sequential/chain.yaml"),
        caller: nonInteractiveCaller,
        receiptDir,
        runxHome,
        env: process.env,
      });

      expect(result.status).toBe("success");
      if (result.status !== "success") {
        return;
      }

      expect(result.steps.map((step) => step.stepId)).toEqual(["first", "second"]);
      expect(result.steps[0].stdout).toBe("hello from chain");
      expect(result.steps[1].stdout).toBe("hello from chain");
      expect(result.steps[1].contextFrom).toEqual([
        {
          input: "message",
          fromStep: "first",
          output: "stdout",
          receiptId: result.steps[0].receiptId,
        },
      ]);
      expect(result.receipt.kind).toBe("chain_execution");
      expect(result.receipt.steps.map((step) => step.receipt_id)).toEqual(result.steps.map((step) => step.receiptId));

      const files = await readdir(receiptDir);
      expect(files).toContain("journals");
      expect(files.filter((file) => file.endsWith(".json"))).toHaveLength(3);
      expect(files).toContain(`${result.receipt.id}.json`);

      const chainReceiptContents = await readFile(path.join(receiptDir, `${result.receipt.id}.json`), "utf8");
      expect(chainReceiptContents).not.toContain("hello from chain");
      expect(chainReceiptContents).not.toContain(process.cwd());
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("passes explicit chain inputs into steps without storing raw inputs in the chain receipt", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-chain-input-"));
    const receiptDir = path.join(tempDir, "receipts");
    const runxHome = path.join(tempDir, "home");

    try {
      const result = await runLocalChain({
        chainPath: path.resolve("fixtures/chains/sequential/input.yaml"),
        inputs: { message: "explicit chain input" },
        caller: nonInteractiveCaller,
        receiptDir,
        runxHome,
        env: process.env,
      });

      expect(result.status).toBe("success");
      if (result.status !== "success") {
        return;
      }
      expect(result.steps[0].stdout).toBe("explicit chain input");

      const chainReceiptContents = await readFile(path.join(receiptDir, `${result.receipt.id}.json`), "utf8");
      expect(chainReceiptContents).not.toContain("explicit chain input");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("inspects a sequential chain receipt", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-composite-inspect-"));
    const receiptDir = path.join(tempDir, "receipts");
    const runxHome = path.join(tempDir, "home");

    try {
      const result = await runLocalChain({
        chainPath: path.resolve("fixtures/chains/sequential/chain.yaml"),
        caller: nonInteractiveCaller,
        receiptDir,
        runxHome,
        env: process.env,
      });

      expect(result.status).toBe("success");
      if (result.status !== "success") {
        return;
      }

      const inspection = await inspectLocalChain({
        chainId: result.receipt.id,
        receiptDir,
        env: process.env,
      });

      expect(inspection.summary).toMatchObject({
        id: result.receipt.id,
        name: "sequential-echo",
        status: "success",
      });
      expect(inspection.summary.steps.map((step) => step.id)).toEqual(["first", "second"]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("inspects a composite receipt through the CLI shell", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-chain-cli-inspect-"));
    const receiptDir = path.join(tempDir, "receipts");
    const stdout = createMemoryStream();
    const stderr = createMemoryStream();

    try {
      const result = await runLocalChain({
        chainPath: path.resolve("fixtures/chains/sequential/chain.yaml"),
        caller: nonInteractiveCaller,
        receiptDir,
        runxHome: path.join(tempDir, "home"),
        env: process.env,
      });
      expect(result.status).toBe("success");
      if (result.status !== "success") {
        return;
      }

      const inspectExit = await runCli(
        ["skill", "inspect", result.receipt.id, "--receipt-dir", receiptDir],
        { stdin: process.stdin, stdout, stderr },
        { ...process.env, RUNX_CWD: process.cwd(), RUNX_HOME: path.join(tempDir, "home") },
      );

      expect(inspectExit).toBe(0);
      expect(stdout.contents()).toContain("sequential-echo");
      expect(stdout.contents()).toContain("chain_execution");
      expect(stdout.contents()).toContain(result.receipt.id);
      expect(stdout.contents()).toContain("verified");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

function createMemoryStream(): NodeJS.WriteStream & { contents: () => string; clear: () => void } {
  let buffer = "";
  return {
    write: (chunk: string | Uint8Array) => {
      buffer += chunk.toString();
      return true;
    },
    contents: () => buffer,
    clear: () => {
      buffer = "";
    },
  } as NodeJS.WriteStream & { contents: () => string; clear: () => void };
}
