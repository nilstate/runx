import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  latestVerifiedReceiptOutcomeResolution,
  loadOrCreateLocalKey,
  readLocalReceipt,
  verifyLocalReceipt,
  writeReceiptOutcomeResolution,
  writeLocalReceipt,
  type LocalReceipt,
} from "./index.js";

describe("local receipts", () => {
  it("assigns distinct receipt ids to identical rapid executions", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-receipt-ids-"));
    const receiptDir = path.join(tempDir, "receipts");
    const runxHome = path.join(tempDir, "home");

    try {
      const base = {
        receiptDir,
        runxHome,
        skillName: "echo",
        sourceType: "cli-tool",
        inputs: { message: "same" },
        stdout: "same-output",
        stderr: "",
        execution: {
          status: "success" as const,
          exitCode: 0,
          signal: null,
          durationMs: 1,
        },
        startedAt: "2026-04-10T00:00:00Z",
        completedAt: "2026-04-10T00:00:01Z",
      };

      const [left, right] = await Promise.all([
        writeLocalReceipt(base),
        writeLocalReceipt(base),
      ]);

      expect(left.id).not.toBe(right.id);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("writes a signed receipt without raw inputs or outputs", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-receipt-"));
    const receiptDir = path.join(tempDir, "receipts");
    const runxHome = path.join(tempDir, "home");

    try {
      const receipt = await writeLocalReceipt({
        receiptDir,
        runxHome,
        skillName: "echo",
        sourceType: "cli-tool",
        inputs: { message: "super-secret-value" },
        stdout: "super-secret-output",
        stderr: "",
        execution: {
          status: "success",
          exitCode: 0,
          signal: null,
          durationMs: 10,
        },
        startedAt: "2026-04-10T00:00:00Z",
        completedAt: "2026-04-10T00:00:01Z",
      });

      const receiptPath = path.join(receiptDir, `${receipt.id}.json`);
      const contents = await readFile(receiptPath, "utf8");
      const parsed = JSON.parse(contents) as LocalReceipt;
      const keyPair = await loadOrCreateLocalKey(runxHome);

      expect(parsed.input_hash).toHaveLength(64);
      expect(parsed.output_hash).toHaveLength(64);
      expect(contents).not.toContain("super-secret-value");
      expect(contents).not.toContain("super-secret-output");
      expect(verifyLocalReceipt(parsed, keyPair.publicKey)).toBe(true);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("throws a specific error when the signing key files are corrupt", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-receipt-corrupt-key-"));
    const runxHome = path.join(tempDir, "home");
    const keysDir = path.join(runxHome, "keys");

    try {
      await mkdir(keysDir, { recursive: true });
      await writeFile(path.join(keysDir, "local-ed25519-private.pem"), "not-a-private-key\n", { mode: 0o600 });
      await writeFile(path.join(keysDir, "local-ed25519-public.pem"), "not-a-public-key\n", { mode: 0o644 });

      await expect(loadOrCreateLocalKey(runxHome)).rejects.toThrow(
        new RegExp("runx signing key unreadable at .*local-ed25519-private\\.pem"),
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects unsafe receipt ids on read", async () => {
    await expect(readLocalReceipt("/tmp", "../escape")).rejects.toThrow("Invalid receipt id");
  });

  it("redacts raw provider secrets from receipt metadata", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-receipt-redaction-"));
    const receiptDir = path.join(tempDir, "receipts");
    const runxHome = path.join(tempDir, "home");

    try {
      const receipt = await writeLocalReceipt({
        receiptDir,
        runxHome,
        skillName: "connected",
        sourceType: "cli-tool",
        inputs: {},
        stdout: "ok",
        stderr: "",
        execution: {
          status: "success",
          exitCode: 0,
          signal: null,
          durationMs: 10,
          metadata: {
            auth: {
              grant_id: "grant_1",
              provider: "github",
              connection_id: "conn_1",
              access_token: "super-secret-token",
            },
          },
        },
      });

      const contents = await readFile(path.join(receiptDir, `${receipt.id}.json`), "utf8");
      expect(contents).toContain('"access_token": "[redacted]"');
      expect(contents).not.toContain("super-secret-token");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("appends outcome resolutions without mutating the original receipt", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-receipt-outcome-"));
    const receiptDir = path.join(tempDir, "receipts");
    const runxHome = path.join(tempDir, "home");

    try {
      const receipt = await writeLocalReceipt({
        receiptDir,
        runxHome,
        skillName: "echo",
        sourceType: "cli-tool",
        inputs: { message: "pending" },
        stdout: "ok",
        stderr: "",
        execution: {
          status: "success",
          exitCode: 0,
          signal: null,
          durationMs: 5,
        },
        outcomeState: "pending",
        disposition: "observing",
        inputContext: {
          source: "inputs",
          snapshot: { message: "pending" },
          bytes: 20,
          max_bytes: 256,
          truncated: false,
          value_hash: "hash",
        },
        surfaceRefs: [{ type: "issue", uri: "github://owner/repo/issues/1" }],
      });

      const receiptPath = path.join(receiptDir, `${receipt.id}.json`);
      const before = await readFile(receiptPath, "utf8");

      const resolution = await writeReceiptOutcomeResolution({
        receiptDir,
        runxHome,
        receiptId: receipt.id,
        outcomeState: "complete",
        source: "observer",
        outcome: {
          code: "confirmed",
          summary: "Observed the durable outcome.",
        },
      });

      const after = await readFile(receiptPath, "utf8");
      const latest = await latestVerifiedReceiptOutcomeResolution(receiptDir, receipt.id, runxHome);

      expect(after).toBe(before);
      expect(resolution.receipt_id).toBe(receipt.id);
      expect(latest).toMatchObject({
        verification: { status: "verified" },
        resolution: {
          id: resolution.id,
          receipt_id: receipt.id,
          outcome_state: "complete",
          source: "observer",
        },
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
